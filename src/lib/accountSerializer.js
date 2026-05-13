function num(v) {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function bool(v) {
  return v === true || v === 'true'
}

function str(v) {
  if (v === undefined || v === null || v === '') return null
  return String(v)
}

function summarizeAccount(hash) {
  if (!hash) return null
  return {
    id: hash.id || null,
    name: hash.name || null,
    platform: hash.platform || null,
    accountType: hash.accountType || null,
    status: hash.status || null,
    schedulable: bool(hash.schedulable),
    sessionWindowStatus: hash.sessionWindowStatus || null,
    sessionWindowStart: hash.sessionWindowStart || null,
    sessionWindowEnd: hash.sessionWindowEnd || null,
    errorMessage: str(hash.errorMessage),
    lastUsedAt: hash.lastUsedAt || null,
    usageUpdatedAt: hash.claudeUsageUpdatedAt || null,
    autoStopOnWarning: bool(hash.autoStopOnWarning),
    fiveHour: {
      resetsAt: hash.claudeFiveHourResetsAt || null,
      utilization: num(hash.claudeFiveHourUtilization)
    },
    sevenDay: {
      resetsAt: hash.claudeSevenDayResetsAt || null,
      utilization: num(hash.claudeSevenDayUtilization),
      opusUtilization: num(hash.claudeSevenDayOpusUtilization),
      opusResetsAt: hash.claudeSevenDayOpusResetsAt || null
    }
  }
}

module.exports = { summarizeAccount }
