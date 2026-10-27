// Read only: all inputs are Magpie's on-disk files. Never call provider APIs.
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const run = promisify(execFile)
const dataRoot = () => process.env.MAGPIE_DATA_DIR || '/config'
const reader = path.join(__dirname, 'magpie_reader.py')
let cachedSnapshot = null
let cachedAt = 0
let inFlight = null

function sameSecret(a, b) {
  if (typeof a !== 'string' || !a || typeof b !== 'string' || !b) return false
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest())
}

async function authenticate(token) {
  const keys = JSON.parse(await fs.readFile(path.join(dataRoot(), 'magpie/caller-keys.json'), 'utf8'))
  if (!Array.isArray(keys)) throw new Error('invalid local gateway key store')
  const key = keys.find(k => sameSecret(token, k.secret))
  if (!key || key.off === true) return null
  // Limited keys must not gain account quota visibility via this viewer.
  if (key.limit || (Array.isArray(key.moreLimits) && key.moreLimits.length) ||
      (Array.isArray(key.models) && key.models.length) || (Array.isArray(key.accounts) && key.accounts.length)) {
    const err = new Error('restricted gateway keys are not supported by this viewer')
    err.status = 403
    throw err
  }
  return { id: key.id, name: key.name, isActive: true }
}

async function readSnapshot() {
  if (cachedSnapshot && Date.now() - cachedAt < 2000) return cachedSnapshot
  if (inFlight) return inFlight
  inFlight = (async () => {
    const { stdout } = await run(process.env.MAGPIE_PYTHON || 'python3', [reader], {
      env: { PATH: process.env.PATH || '/usr/bin:/bin', MAGPIE_DATA_DIR: dataRoot(), PYTHONDONTWRITEBYTECODE: '1' },
      timeout: 15000, maxBuffer: 4 * 1024 * 1024
    })
    cachedSnapshot = JSON.parse(stdout)
    cachedAt = Date.now()
    return cachedSnapshot
  })()
  try { return await inFlight } finally { inFlight = null }
}

function emptyTokens() { return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 } }
function accountWindow(w, snapshot) {
  if (!w) return { resetsAt: null, utilization: null, windowStart: null, windowEnd: null }
  return { resetsAt: w.reset_at, utilization: w.snapshot_window_expired || w.snapshot_outside_window ? null : w.account_used_percent_snapshot,
    windowStart: w.start, windowEnd: w.records_through, snapshotAt: snapshot }
}
function accountInfo(account) {
  const five = account.windows.find(w => w.name === '5 hours')
  const seven = account.windows.find(w => w.name === '7 days')
  return { id: account.account, name: account.account.replace(/^claude\//, ''), platform: 'claude',
    accountType: account.plan || null, status: 'active', schedulable: true, usageUpdatedAt: account.snapshot_at,
    fiveHour: accountWindow(five, account.snapshot_at), sevenDay: { ...accountWindow(seven, account.snapshot_at), opusUtilization: null, opusResetsAt: null } }
}
function keyWindow(w, keyId) {
  if (!w) return { windowStart: null, windowEnd: null, resetsAt: null, cost: null, tokens: emptyTokens(), requests: 0,
    activeHours: 0, accountTotalCost: null, shareOfAccount: null, accountUtilization: null, contributionToUtilization: null }
  const item = w.keys.find(k => k.key_id === keyId)
  const valid = !w.snapshot_window_expired && !w.snapshot_outside_window
  const percent = item && item.share_of_recorded_cost_percent
  return { windowStart: w.start, windowEnd: w.records_through, resetsAt: w.reset_at,
    cost: item ? item.estimated_cost_usd : 0, tokens: item ? item.tokens : emptyTokens(),
    requests: item ? item.calls : 0, activeHours: item ? item.active_hours : 0,
    accountTotalCost: w.estimated_recorded_cost_usd,
    shareOfAccount: valid && percent != null ? percent / 100 : null,
    accountUtilization: valid ? w.account_used_percent_snapshot : null,
    contributionToUtilization: valid && item ? item.estimated_account_quota_percentage_points : null,
    unpricedCalls: w.unpriced_calls, snapshotExpired: !valid }
}
function quality(data, account) {
  return { costType: 'estimated_api_equivalent', scope: data.scope, disclaimer: data.disclaimer,
    priceSource: data.price_source, snapshotAt: account.snapshot_at, snapshotAgeSeconds: account.snapshot_age_seconds,
    malformedUsageRows: data.malformed_usage_rows }
}
function keyReports(data, key) {
  let accounts = data.accounts || []
  if (accounts.length > 1) {
    accounts = accounts.filter(a => a.windows.some(w => w.keys.some(k => k.key_id === key.id && k.calls > 0)))
  }
  return accounts.map(a => {
    const info = accountInfo(a)
    const five = a.windows.find(w => w.name === '5 hours')
    const seven = a.windows.find(w => w.name === '7 days')
    return { key: { ...key, accountId: info.id, accountName: info.name }, account: info,
      fiveHour: keyWindow(five, key.id), sevenDay: keyWindow(seven, key.id), dataQuality: quality(data, a) }
  })
}
function fullReport(data, a) {
  const info = accountInfo(a)
  const convert = label => {
    const w = a.windows.find(x => x.name === label)
    if (!w) return { items: [], cost: null, tokens: emptyTokens() }
    const items = w.keys.map(k => ({ id: k.key_id, name: k.key_name, isActive: k.is_active,
      cost: k.estimated_cost_usd, tokens: k.tokens, requests: k.calls, activeHours: k.active_hours,
      shareOfWindow: w.snapshot_window_expired || w.snapshot_outside_window || k.share_of_recorded_cost_percent == null ? null : k.share_of_recorded_cost_percent / 100,
      contributionToUtilization: w.snapshot_window_expired || w.snapshot_outside_window ? null : k.estimated_account_quota_percentage_points }))
    const tokens = emptyTokens()
    for (const item of items) for (const field of Object.keys(tokens)) tokens[field] += (item.tokens || {})[field] || 0
    return { items, cost: w.estimated_recorded_cost_usd, tokens }
  }
  const five = convert('5 hours'), seven = convert('7 days')
  return { account: info, keys: { fiveHour: five.items, sevenDay: seven.items },
    totals: { fiveHour: { cost: five.cost, tokens: five.tokens }, sevenDay: { cost: seven.cost, tokens: seven.tokens } },
    dataQuality: quality(data, a) }
}

module.exports = { authenticate, readSnapshot, keyReports, fullReport, sameSecret }
