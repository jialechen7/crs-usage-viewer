const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

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

function iterHourKeys(start, end) {
  const keys = []
  const t = new Date(start)
  t.setUTCMinutes(0, 0, 0)
  while (t < end) {
    const yyyy = t.getUTCFullYear()
    const mm = String(t.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(t.getUTCDate()).padStart(2, '0')
    const hh = String(t.getUTCHours()).padStart(2, '0')
    keys.push({ date: `${yyyy}-${mm}-${dd}`, hour: hh })
    t.setUTCHours(t.getUTCHours() + 1)
  }
  return keys
}

module.exports = { resolveFiveHourWindow, resolveSevenDayWindow, iterHourKeys }
