// crs2 backend: reads crs2 (sub2api) usage from PostgreSQL.
// sub2api's data model differs from CRS:
//   - accounts.session_window_* is the Anthropic 5h session window; there is
//     NO Anthropic utilization percentage, so all utilization fields are null.
//   - api_keys.key is plaintext (sk-...), so token lookup is a direct equality
//     match — no sha256/ENCRYPTION_KEY like CRS.
//   - usage_logs is the canonical per-request source; any window is aggregated
//     from it. Keys are NOT statically bound to one account.
// Output field names mirror the crs backend so a single client parses both.
const { query } = require('../pg')
const { round } = require('../lib/usageAggregator')

const API_KEY_PREFIX = process.env.CRS2_API_KEY_PREFIX || 'sk-'
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

function iso(d) {
  return d ? new Date(d).toISOString() : null
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 }
}

// Shared SELECT list so account/key aggregations stay in sync.
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

async function health() {
  try {
    await query('SELECT 1')
    return { ok: true, detail: 'connected' }
  } catch (err) {
    return { ok: false, detail: `error: ${err.message}` }
  }
}

function summarizeAccountRow(a) {
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
    fiveHour: {
      resetsAt: iso(a.session_window_end),
      utilization: null
    },
    sevenDay: {
      resetsAt: null,
      utilization: null,
      opusUtilization: null,
      opusResetsAt: null
    },
    lastUsedAt: iso(a.last_used_at),
    usageUpdatedAt: iso(a.updated_at)
  }
}

const ACCOUNT_COLS =
  'id, name, platform, type, status, schedulable, session_window_start, ' +
  'session_window_end, session_window_status, last_used_at, updated_at, error_message'

async function listAccounts() {
  const { rows } = await query(
    `SELECT ${ACCOUNT_COLS} FROM accounts WHERE deleted_at IS NULL ORDER BY id`
  )
  return rows.map(summarizeAccountRow)
}

// 5h window: anchored on the account's Anthropic session window when present,
// otherwise a rolling 5h. 7d window: rolling (sub2api has no account-level 7d).
function accountWindows(accountRow, now) {
  const start5h = accountRow.session_window_start
    ? new Date(accountRow.session_window_start)
    : new Date(now.getTime() - FIVE_HOURS_MS)
  return {
    fiveHour: {
      start: start5h,
      end: now,
      resetsAt: accountRow.session_window_end ? new Date(accountRow.session_window_end) : null
    },
    sevenDay: {
      start: new Date(now.getTime() - SEVEN_DAYS_MS),
      end: now,
      resetsAt: null
    }
  }
}

async function collectAccountWindow(accountId, window) {
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
    // sub2api has no Anthropic utilization to apportion.
    item.contributionToUtilization = null
  }
  return { items, totalCost: round(totalCost, 4), totalTokens }
}

async function buildAccountReport(accountRow, now) {
  const windows = accountWindows(accountRow, now)
  const fiveHour = await collectAccountWindow(accountRow.id, windows.fiveHour)
  const sevenDay = await collectAccountWindow(accountRow.id, windows.sevenDay)

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
        windowStart: iso(windows.fiveHour.start),
        windowEnd: iso(windows.fiveHour.end),
        resetsAt: iso(windows.fiveHour.resetsAt),
        utilization: null
      },
      sevenDay: {
        windowStart: iso(windows.sevenDay.start),
        windowEnd: iso(windows.sevenDay.end),
        resetsAt: null,
        utilization: null,
        opusUtilization: null
      },
      usageUpdatedAt: summary.usageUpdatedAt
    },
    keys: {
      fiveHour: fiveHour.items,
      sevenDay: sevenDay.items
    },
    totals: {
      fiveHour: { cost: fiveHour.totalCost, tokens: fiveHour.totalTokens },
      sevenDay: { cost: sevenDay.totalCost, tokens: sevenDay.totalTokens }
    }
  }
}

async function accountReport(name, now) {
  const { rows } = await query(
    `SELECT ${ACCOUNT_COLS} FROM accounts WHERE name = $1 AND deleted_at IS NULL ORDER BY id`,
    [name]
  )
  if (rows.length === 0) return { found: false, reports: [] }
  const reports = []
  for (const acc of rows) {
    reports.push(await buildAccountReport(acc, now))
  }
  return { found: true, reports }
}

function looksLikeToken(s) {
  return typeof s === 'string' && s.startsWith(API_KEY_PREFIX)
}

// Per-key window: rolling (keys have no Anthropic session window), broken down
// by account because a crs2 key can be served by multiple upstream accounts.
async function collectKeyWindow(keyId, start, end) {
  const totalP = query(
    `SELECT ${USAGE_SELECT} FROM usage_logs u
     WHERE u.api_key_id = $1 AND u.created_at >= $2 AND u.created_at <= $3`,
    [keyId, start, end]
  )
  const byAcctP = query(
    `SELECT u.account_id, ${USAGE_SELECT}, a.name AS account_name
     FROM usage_logs u
     LEFT JOIN accounts a ON a.id = u.account_id
     WHERE u.api_key_id = $1 AND u.created_at >= $2 AND u.created_at <= $3
     GROUP BY u.account_id, a.name
     ORDER BY cost DESC`,
    [keyId, start, end]
  )
  const [totalRes, byAcctRes] = await Promise.all([totalP, byAcctP])
  const usage = rowToUsage(totalRes.rows[0])
  const byAccount = byAcctRes.rows.map((r) => {
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
  return {
    windowStart: iso(start),
    windowEnd: iso(end),
    resetsAt: null,
    cost: round(usage.cost, 4),
    tokens: usage.tokens,
    requests: usage.requests,
    activeHours: usage.activeHours,
    byAccount
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

  const start5h = new Date(now.getTime() - FIVE_HOURS_MS)
  const start7d = new Date(now.getTime() - SEVEN_DAYS_MS)

  const reports = []
  for (const k of rows) {
    const [fiveHour, sevenDay] = await Promise.all([
      collectKeyWindow(k.id, start5h, now),
      collectKeyWindow(k.id, start7d, now)
    ])
    reports.push({
      key: {
        id: String(k.id),
        name: k.name,
        isActive: k.status === 'active',
        userId: k.user_id != null ? String(k.user_id) : null,
        // crs2 keys are not statically bound to a single account.
        accountId: null,
        accountName: null
      },
      account: null,
      fiveHour,
      sevenDay
    })
  }
  return { matches: reports, mode }
}

module.exports = {
  name: 'crs2',
  health,
  listAccounts,
  accountReport,
  keyReport
}
