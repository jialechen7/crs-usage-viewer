// crs2 backend: reads crs2 (sub2api) usage from PostgreSQL.
// sub2api differs from CRS in storage but DOES track upstream utilization in
// accounts.extra (Anthropic: session_window_utilization / passive_usage_7d_*;
// OpenAI/Codex: codex_*_used_percent). So crs2 produces the SAME report shape
// as the crs backend (utilization + per-key share), and a single client renders
// both. Per-key usage is aggregated from usage_logs.
//   - api_keys.key is plaintext (sk-...), so token lookup is direct equality.
//   - A key is not statically bound to one account; its "primary account" is the
//     one that served the most cost in the trailing window (byAccount keeps the
//     full breakdown).
const { query } = require('../pg')
const { round } = require('../lib/usageAggregator')
const {
  applyManualResetOverride,
  applyQuotaResetCursor,
  utilizationForWindow
} = require('../lib/quotaResetTracker')

const API_KEY_PREFIX = process.env.CRS2_API_KEY_PREFIX || 'sk-'
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const QUOTA_RESET_SAMPLER_INTERVAL_MS = Number(
  process.env.QUOTA_RESET_SAMPLER_INTERVAL_MS || 60000
)

function iso(d) {
  if (d == null) return null
  const t = d instanceof Date ? d : new Date(d)
  return Number.isNaN(t.getTime()) ? null : t.toISOString()
}

function num(v) {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 }
}

// Shared SELECT list (table aliased u) so account/key aggregations stay in sync.
const USAGE_SELECT = `
  COALESCE(sum(total_cost), 0)            AS cost,
  COALESCE(sum(input_tokens), 0)          AS input_tokens,
  COALESCE(sum(output_tokens), 0)         AS output_tokens,
  COALESCE(sum(cache_read_tokens), 0)     AS cache_read_tokens,
  COALESCE(sum(cache_creation_tokens), 0) AS cache_creation_tokens,
  count(*)                                AS requests,
  count(distinct date_trunc('hour', u.created_at)) AS active_hours`

function rowToUsage(r) {
  const input = parseInt(r.input_tokens, 10) || 0
  const output = parseInt(r.output_tokens, 10) || 0
  const cacheRead = parseInt(r.cache_read_tokens, 10) || 0
  const cacheCreate = parseInt(r.cache_creation_tokens, 10) || 0
  return {
    cost: parseFloat(r.cost) || 0,
    tokens: { input, output, cacheRead, cacheCreate, total: input + output + cacheRead + cacheCreate },
    requests: parseInt(r.requests, 10) || 0,
    activeHours: parseInt(r.active_hours, 10) || 0
  }
}

const ACCOUNT_COLS =
  'id, name, platform, type, status, schedulable, session_window_start, ' +
  'session_window_end, session_window_status, last_used_at, updated_at, error_message, extra'

// Normalize the upstream 5h/7d utilization sub2api scrapes into accounts.extra.
// Anthropic stores fractions (0–1); Codex stores integer percents (0–100).
// Returns everything already in CRS units: utilization 0–100, resets as ISO.
function utilFromAccount(a) {
  const extra = a.extra && typeof a.extra === 'object' ? a.extra : {}

  let fiveUtil = null
  if (extra.codex_5h_used_percent != null) fiveUtil = num(extra.codex_5h_used_percent)
  else if (extra.session_window_utilization != null) {
    const f = num(extra.session_window_utilization)
    fiveUtil = f == null ? null : round(f * 100, 4)
  }

  let sevenUtil = null
  if (extra.codex_7d_used_percent != null) sevenUtil = num(extra.codex_7d_used_percent)
  else if (extra.passive_usage_7d_utilization != null) {
    const f = num(extra.passive_usage_7d_utilization)
    sevenUtil = f == null ? null : round(f * 100, 4)
  }

  const fiveReset =
    iso(a.session_window_end) || iso(extra.codex_5h_reset_at) || null
  let sevenReset = null
  if (extra.passive_usage_7d_reset != null) {
    const sec = num(extra.passive_usage_7d_reset)
    if (sec != null) sevenReset = iso(new Date(sec * 1000))
  }
  if (!sevenReset) sevenReset = iso(extra.codex_7d_reset_at)

  const sampledAt =
    iso(extra.passive_usage_sampled_at) || iso(extra.codex_usage_updated_at) || iso(a.updated_at)

  return {
    fiveHour: { utilization: fiveUtil, resetsAt: fiveReset },
    // sub2api has no per-model (Opus) breakdown → opusUtilization stays null.
    sevenDay: { utilization: sevenUtil, resetsAt: sevenReset, opusUtilization: null, opusResetsAt: null },
    sampledAt
  }
}

// Aggregation windows aligned to the utilization resets so a key's cost share
// lines up with the utilization the share is multiplied against.
async function accountWindows(a, now, options = {}) {
  const u = utilFromAccount(a)
  const reset5h = u.fiveHour.resetsAt ? new Date(u.fiveHour.resetsAt) : null
  const reset7d = u.sevenDay.resetsAt ? new Date(u.sevenDay.resetsAt) : null
  const start5h = a.session_window_start
    ? new Date(a.session_window_start)
    : reset5h
      ? new Date(reset5h.getTime() - FIVE_HOURS_MS)
      : new Date(now.getTime() - FIVE_HOURS_MS)
  const start7d = reset7d
    ? new Date(reset7d.getTime() - SEVEN_DAYS_MS)
    : new Date(now.getTime() - SEVEN_DAYS_MS)
  const nominalFiveHourWindow = { start: start5h, end: now, resetsAt: u.fiveHour.resetsAt }
  const nominalSevenDayWindow = { start: start7d, end: now, resetsAt: u.sevenDay.resetsAt }
  if (options.effectiveWindows === false) {
    return {
      util: u,
      fiveHour: applyManualResetOverride({
        backend: 'crs2',
        accountId: a.id,
        windowType: 'fiveHour',
        window: nominalFiveHourWindow
      }),
      sevenDay: applyManualResetOverride({
        backend: 'crs2',
        accountId: a.id,
        windowType: 'sevenDay',
        window: nominalSevenDayWindow
      })
    }
  }
  const fiveHour = applyQuotaResetCursor({
    backend: 'crs2',
    accountId: a.id,
    windowType: 'fiveHour',
    window: nominalFiveHourWindow,
    utilization: u.fiveHour.utilization,
    observedAt: u.sampledAt,
    now
  })
  const sevenDay = applyQuotaResetCursor({
    backend: 'crs2',
    accountId: a.id,
    windowType: 'sevenDay',
    window: nominalSevenDayWindow,
    utilization: u.sevenDay.utilization,
    observedAt: u.sampledAt,
    now
  })
  return {
    util: u,
    fiveHour,
    sevenDay
  }
}

async function health() {
  try {
    await query('SELECT 1')
    return { ok: true, detail: 'connected' }
  } catch (err) {
    return { ok: false, detail: `error: ${err.message}` }
  }
}

function summarizeAccountRow(a) {
  const u = utilFromAccount(a)
  return {
    id: String(a.id),
    name: a.name,
    platform: a.platform,
    accountType: a.type,
    status: a.status,
    schedulable: a.schedulable === true,
    sessionWindowStatus: a.session_window_status || null,
    sessionWindowStart: iso(a.session_window_start),
    sessionWindowEnd: iso(a.session_window_end),
    errorMessage: a.error_message || null,
    fiveHour: { resetsAt: u.fiveHour.resetsAt, utilization: u.fiveHour.utilization },
    sevenDay: {
      resetsAt: u.sevenDay.resetsAt,
      utilization: u.sevenDay.utilization,
      opusUtilization: u.sevenDay.opusUtilization,
      opusResetsAt: u.sevenDay.opusResetsAt
    },
    lastUsedAt: iso(a.last_used_at),
    usageUpdatedAt: u.sampledAt
  }
}

async function listAccounts() {
  const { rows } = await query(
    `SELECT ${ACCOUNT_COLS} FROM accounts WHERE deleted_at IS NULL ORDER BY id`
  )
  return rows.map(summarizeAccountRow)
}

async function sampleQuotaWindows() {
  const { rows } = await query(
    `SELECT ${ACCOUNT_COLS} FROM accounts WHERE deleted_at IS NULL ORDER BY id`
  )
  const now = new Date()
  for (const account of rows) {
    await accountWindows(account, now)
  }
}

function startQuotaSampler() {
  if (!QUOTA_RESET_SAMPLER_INTERVAL_MS) return

  const run = async () => {
    try {
      await sampleQuotaWindows()
    } catch (err) {
      console.error('[crs2] quota sampler failed', err.message)
    }
  }

  setTimeout(run, 1000)
  setInterval(run, QUOTA_RESET_SAMPLER_INTERVAL_MS)
}

async function collectAccountWindow(accountId, window, utilization) {
  const { rows } = await query(
    `SELECT u.api_key_id, ${USAGE_SELECT},
            k.name AS key_name, k.status AS key_status
     FROM usage_logs u
     LEFT JOIN api_keys k ON k.id = u.api_key_id
     WHERE u.account_id = $1 AND u.created_at >= $2 AND u.created_at <= $3
     GROUP BY u.api_key_id, k.name, k.status
     ORDER BY cost DESC`,
    [accountId, window.start, window.end]
  )

  const items = rows.map((r) => {
    const usage = rowToUsage(r)
    return {
      id: String(r.api_key_id),
      name: r.key_name || null,
      isActive: r.key_status === 'active',
      cost: round(usage.cost, 4),
      tokens: usage.tokens,
      requests: usage.requests,
      activeHours: usage.activeHours
    }
  })

  const totalCost = items.reduce((s, x) => s + x.cost, 0)
  const totalTokens = items.reduce(
    (s, x) => ({
      input: s.input + x.tokens.input,
      output: s.output + x.tokens.output,
      cacheRead: s.cacheRead + x.tokens.cacheRead,
      cacheCreate: s.cacheCreate + x.tokens.cacheCreate,
      total: s.total + x.tokens.total
    }),
    emptyTokens()
  )
  for (const item of items) {
    item.shareOfWindow = totalCost > 0 ? round(item.cost / totalCost, 8) : 0
    item.contributionToUtilization =
      utilization != null ? round(utilization * item.shareOfWindow, 4) : null
  }
  return { items, totalCost: round(totalCost, 4), totalTokens }
}

async function buildAccountReport(accountRow, now, options = {}) {
  const w = await accountWindows(accountRow, now, options)
  const fiveHourUtilization = utilizationForWindow(
    w.util.fiveHour.utilization,
    w.fiveHour,
    w.util.sampledAt
  )
  const sevenDayUtilization = utilizationForWindow(
    w.util.sevenDay.utilization,
    w.sevenDay,
    w.util.sampledAt
  )
  const fiveHour = await collectAccountWindow(accountRow.id, w.fiveHour, fiveHourUtilization)
  const sevenDay = await collectAccountWindow(accountRow.id, w.sevenDay, sevenDayUtilization)
  const summary = summarizeAccountRow(accountRow)

  return {
    account: {
      id: summary.id,
      name: summary.name,
      platform: summary.platform,
      accountType: summary.accountType,
      status: summary.status,
      sessionWindowStatus: summary.sessionWindowStatus,
      fiveHour: {
        windowStart: iso(w.fiveHour.start),
        windowEnd: iso(w.fiveHour.end),
        resetsAt: w.fiveHour.resetsAt,
        quotaResetAt: w.fiveHour.quotaResetAt || null,
        utilization: fiveHourUtilization
      },
      sevenDay: {
        windowStart: iso(w.sevenDay.start),
        windowEnd: iso(w.sevenDay.end),
        resetsAt: w.sevenDay.resetsAt,
        quotaResetAt: w.sevenDay.quotaResetAt || null,
        quotaResetDetectedBy: w.sevenDay.quotaResetDetectedBy || null,
        utilization: sevenDayUtilization,
        opusUtilization: w.util.sevenDay.opusUtilization
      },
      usageUpdatedAt: summary.usageUpdatedAt
    },
    keys: { fiveHour: fiveHour.items, sevenDay: sevenDay.items },
    totals: {
      fiveHour: { cost: fiveHour.totalCost, tokens: fiveHour.totalTokens },
      sevenDay: { cost: sevenDay.totalCost, tokens: sevenDay.totalTokens }
    }
  }
}

async function accountReport(name, now, options = {}) {
  const { rows } = await query(
    `SELECT ${ACCOUNT_COLS} FROM accounts WHERE name = $1 AND deleted_at IS NULL ORDER BY id`,
    [name]
  )
  if (rows.length === 0) return { found: false, reports: [] }
  const reports = []
  for (const acc of rows) reports.push(await buildAccountReport(acc, now, options))
  return { found: true, reports }
}

function looksLikeToken(s) {
  return typeof s === 'string' && s.startsWith(API_KEY_PREFIX)
}

async function loadAccountById(accountId) {
  const { rows } = await query(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = $1`, [accountId])
  return rows[0] || null
}

// The key's cost + its account-total cost within one window, for a share calc.
async function keyShareInWindow(accountId, keyId, window) {
  const mineP = query(
    `SELECT ${USAGE_SELECT} FROM usage_logs u
     WHERE u.account_id = $1 AND u.api_key_id = $2 AND u.created_at >= $3 AND u.created_at <= $4`,
    [accountId, keyId, window.start, window.end]
  )
  const totalP = query(
    `SELECT COALESCE(sum(total_cost), 0) AS cost FROM usage_logs
     WHERE account_id = $1 AND created_at >= $2 AND created_at <= $3`,
    [accountId, window.start, window.end]
  )
  const [mineRes, totalRes] = await Promise.all([mineP, totalP])
  const mine = rowToUsage(mineRes.rows[0])
  const accountTotal = parseFloat(totalRes.rows[0].cost) || 0
  return { mine, accountTotal }
}

function windowReport(window, mine, accountTotal, utilization) {
  const share = accountTotal > 0 ? mine.cost / accountTotal : 0
  return {
    windowStart: iso(window.start),
    windowEnd: iso(window.end),
    resetsAt: window.resetsAt,
    quotaResetAt: window.quotaResetAt || null,
    quotaResetDetectedBy: window.quotaResetDetectedBy || null,
    cost: round(mine.cost, 4),
    tokens: mine.tokens,
    requests: mine.requests,
    activeHours: mine.activeHours,
    accountTotalCost: round(accountTotal, 4),
    shareOfAccount: round(share, 8),
    accountUtilization: utilization,
    contributionToUtilization: utilization != null ? round(utilization * share, 4) : null
  }
}

function emptyWindowReport() {
  return {
    windowStart: null,
    windowEnd: null,
    resetsAt: null,
    cost: 0,
    tokens: emptyTokens(),
    requests: 0,
    activeHours: 0,
    accountTotalCost: 0,
    shareOfAccount: null,
    accountUtilization: null,
    contributionToUtilization: null
  }
}

function accountDetail(accountRow) {
  if (!accountRow) return null
  const s = summarizeAccountRow(accountRow)
  return {
    id: s.id,
    name: s.name,
    platform: s.platform,
    accountType: s.accountType,
    status: s.status,
    schedulable: s.schedulable,
    sessionWindowStatus: s.sessionWindowStatus,
    sessionWindowStart: s.sessionWindowStart,
    sessionWindowEnd: s.sessionWindowEnd,
    errorMessage: s.errorMessage,
    fiveHour: s.fiveHour,
    sevenDay: s.sevenDay,
    lastUsedAt: s.lastUsedAt,
    usageUpdatedAt: s.usageUpdatedAt
  }
}

// The key's cost split across the accounts that served it in the trailing 7d.
async function keyByAccount(keyId, start, end) {
  const { rows } = await query(
    `SELECT u.account_id, ${USAGE_SELECT}, a.name AS account_name
     FROM usage_logs u
     LEFT JOIN accounts a ON a.id = u.account_id
     WHERE u.api_key_id = $1 AND u.created_at >= $2 AND u.created_at <= $3
     GROUP BY u.account_id, a.name
     ORDER BY cost DESC`,
    [keyId, start, end]
  )
  return rows.map((r) => {
    const u = rowToUsage(r)
    return {
      accountId: r.account_id != null ? String(r.account_id) : null,
      accountName: r.account_name || null,
      cost: round(u.cost, 4),
      tokens: u.tokens,
      requests: u.requests,
      activeHours: u.activeHours
    }
  })
}

async function buildKeyReport(keyRow, now) {
  const since7d = new Date(now.getTime() - SEVEN_DAYS_MS)
  const trailingByAccount = await keyByAccount(keyRow.id, since7d, now)
  // Primary account = where this key spent the most in the trailing 7d.
  const primary = trailingByAccount.find((b) => b.accountId != null) || null
  const accountRow = primary ? await loadAccountById(primary.accountId) : null

  let fiveHour = emptyWindowReport()
  let sevenDay = emptyWindowReport()
  let fiveHourByAccount = []
  let sevenDayByAccount = []
  if (accountRow) {
    const w = await accountWindows(accountRow, now)
    const fiveHourUtilization = utilizationForWindow(
      w.util.fiveHour.utilization,
      w.fiveHour,
      w.util.sampledAt
    )
    const sevenDayUtilization = utilizationForWindow(
      w.util.sevenDay.utilization,
      w.sevenDay,
      w.util.sampledAt
    )
    const [fiveShare, sevenShare, fiveBreakdown, sevenBreakdown] = await Promise.all([
      keyShareInWindow(accountRow.id, keyRow.id, w.fiveHour),
      keyShareInWindow(accountRow.id, keyRow.id, w.sevenDay),
      keyByAccount(keyRow.id, w.fiveHour.start, w.fiveHour.end),
      keyByAccount(keyRow.id, w.sevenDay.start, w.sevenDay.end)
    ])
    fiveHour = windowReport(w.fiveHour, fiveShare.mine, fiveShare.accountTotal, fiveHourUtilization)
    sevenDay = windowReport(w.sevenDay, sevenShare.mine, sevenShare.accountTotal, sevenDayUtilization)
    fiveHourByAccount = fiveBreakdown
    sevenDayByAccount = sevenBreakdown
  }
  fiveHour.byAccount = fiveHourByAccount
  sevenDay.byAccount = sevenDayByAccount

  const detail = accountDetail(accountRow)
  return {
    key: {
      id: String(keyRow.id),
      name: keyRow.name,
      isActive: keyRow.status === 'active',
      userId: keyRow.user_id != null ? String(keyRow.user_id) : null,
      accountId: detail ? detail.id : null,
      accountName: detail ? detail.name : null
    },
    account: detail,
    fiveHour,
    sevenDay
  }
}

async function keyReport(identifier, now) {
  const mode = looksLikeToken(identifier) ? 'token' : 'name'
  const where = mode === 'token' ? 'key = $1' : 'name = $1'
  const { rows } = await query(
    `SELECT id, name, status, user_id FROM api_keys
     WHERE ${where} AND deleted_at IS NULL ORDER BY id`,
    [identifier]
  )
  if (rows.length === 0) return { matches: [], mode }
  const reports = []
  for (const k of rows) reports.push(await buildKeyReport(k, now))
  return { matches: reports, mode }
}

module.exports = {
  name: 'crs2',
  health,
  listAccounts,
  accountReport,
  keyReport,
  startQuotaSampler
}
