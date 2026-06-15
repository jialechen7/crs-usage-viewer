const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

// CRS 用 TIMEZONE_OFFSET 切 hourly/daily key 的日期与小时。
// 默认 UTC+8(北京时间),必须与 CRS 服务端 .env 的 TIMEZONE_OFFSET 完全一致,
// 否则读到的 key 全是 0(我们查的小时和它写入时拼的小时不一致)。
const TIMEZONE_OFFSET_HOURS = Number(process.env.TIMEZONE_OFFSET || 8)
const TIMEZONE_OFFSET_MS = TIMEZONE_OFFSET_HOURS * 3600000
const { applyQuotaResetCursor } = require('./quotaResetTracker')

function parseIso(s) {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

function resolveFiveHourWindow(accountHash, now = new Date()) {
  const resetsAt = parseIso(accountHash.claudeFiveHourResetsAt)
  if (!resetsAt) return null
  const start = new Date(resetsAt.getTime() - FIVE_HOURS_MS)
  return { start, end: now, resetsAt }
}

function resolveSevenDayWindow(accountHash, now = new Date()) {
  const resetsAt = parseIso(accountHash.claudeSevenDayResetsAt)
  if (!resetsAt) return null
  const start = new Date(resetsAt.getTime() - SEVEN_DAYS_MS)
  return { start, end: now, resetsAt }
}

function resolveEffectiveFiveHourWindow(accountHash, now = new Date()) {
  const window = resolveFiveHourWindow(accountHash, now)
  return applyQuotaResetCursor({
    backend: 'crs',
    accountId: accountHash && accountHash.id,
    windowType: 'fiveHour',
    window,
    utilization: accountHash && accountHash.claudeFiveHourUtilization,
    observedAt: accountHash && accountHash.claudeUsageUpdatedAt,
    now
  })
}

function resolveEffectiveSevenDayWindow(accountHash, now = new Date()) {
  const window = resolveSevenDayWindow(accountHash, now)
  return applyQuotaResetCursor({
    backend: 'crs',
    accountId: accountHash && accountHash.id,
    windowType: 'sevenDay',
    window,
    utilization: accountHash && accountHash.claudeSevenDayUtilization,
    observedAt: accountHash && accountHash.claudeUsageUpdatedAt,
    now
  })
}

// 返回 CRS 时区下 (yyyy-mm-dd, HH) 用于拼 Redis key。
function dateHourInTz(t) {
  const tz = new Date(t.getTime() + TIMEZONE_OFFSET_MS)
  const yyyy = tz.getUTCFullYear()
  const mm = String(tz.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(tz.getUTCDate()).padStart(2, '0')
  const hh = String(tz.getUTCHours()).padStart(2, '0')
  return { date: `${yyyy}-${mm}-${dd}`, hour: hh }
}

function iterHourKeys(start, end) {
  const keys = []
  // 步进按 CRS 时区的整点对齐:先把 start 落到 tz 整点,再以 UTC 1 小时步进。
  const tzStart = new Date(start.getTime() + TIMEZONE_OFFSET_MS)
  tzStart.setUTCMinutes(0, 0, 0)
  const t = new Date(tzStart.getTime() - TIMEZONE_OFFSET_MS)
  while (t < end) {
    keys.push(dateHourInTz(t))
    t.setUTCHours(t.getUTCHours() + 1)
  }
  return keys
}

module.exports = {
  resolveFiveHourWindow,
  resolveSevenDayWindow,
  resolveEffectiveFiveHourWindow,
  resolveEffectiveSevenDayWindow,
  iterHourKeys,
  dateHourInTz,
  TIMEZONE_OFFSET_HOURS
}
