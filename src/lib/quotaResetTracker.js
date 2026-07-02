const fs = require('fs')
const path = require('path')

const DEFAULT_STATE_PATH = path.join(process.cwd(), '.quota-reset-state.json')
const STATE_PATH = process.env.QUOTA_RESET_STATE_PATH || DEFAULT_STATE_PATH
const DEFAULT_OVERRIDES_PATH = path.join(process.cwd(), '.quota-reset-overrides.json')
const OVERRIDES_PATH = process.env.QUOTA_RESET_OVERRIDES_PATH || DEFAULT_OVERRIDES_PATH
const DROP_EPSILON = 0.0001
const ENABLE_UTILIZATION_DROP_RESETS = process.env.ENABLE_UTILIZATION_DROP_RESETS === 'true'
const RESET_UTILIZATION_DROP_MIN = Number(process.env.RESET_UTILIZATION_DROP_MIN || 1)
const RESET_TIME_CHANGE_TOLERANCE_MS = Number(
  process.env.RESET_TIME_CHANGE_TOLERANCE_MS || 5 * 60 * 1000
)

let loaded = false
let state = {}
let overridesLoaded = false
let overrides = {}

function parseDate(value) {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function readState() {
  if (loaded) return state
  loaded = true
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8')
    if (!raw.trim()) {
      state = {}
      return state
    }
    const parsed = JSON.parse(raw)
    state = parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[quota-reset-tracker] read failed', err.message)
    }
    state = {}
  }
  return state
}

function writeState() {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
  } catch (err) {
    console.error('[quota-reset-tracker] write failed', err.message)
  }
}

function readOverrides() {
  if (overridesLoaded) return overrides
  overridesLoaded = true
  try {
    const raw = fs.readFileSync(OVERRIDES_PATH, 'utf8')
    if (!raw.trim()) {
      overrides = {}
      return overrides
    }
    const parsed = JSON.parse(raw)
    overrides = parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[quota-reset-tracker] override read failed', err.message)
    }
    overrides = {}
  }
  return overrides
}

function writeOverrides() {
  try {
    fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2))
  } catch (err) {
    console.error('[quota-reset-tracker] override write failed', err.message)
    throw err
  }
}

function stateKey({ backend, accountId, windowType }) {
  return [backend || 'unknown', accountId || 'unknown', windowType].join(':')
}

function iso(value) {
  const d = parseDate(value)
  return d ? d.toISOString() : null
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function latestDate(...values) {
  let latest = null
  for (const value of values) {
    const d = parseDate(value)
    if (d && (!latest || d > latest)) latest = d
  }
  return latest
}

function materiallyDifferentReset(previousReset, currentReset) {
  const previous = parseDate(previousReset)
  const current = parseDate(currentReset)
  if (!previous && !current) return false
  if (!previous || !current) return true
  return Math.abs(previous.getTime() - current.getTime()) > RESET_TIME_CHANGE_TOLERANCE_MS
}

function isSevenDayUtilizationReset(windowType, previousUtilization, currentUtilization) {
  if (windowType !== 'sevenDay') return false
  if (previousUtilization === null || currentUtilization === null) return false
  return previousUtilization - currentUtilization >= RESET_UTILIZATION_DROP_MIN
}

function getQuotaResetCursor({ backend, accountId, windowType }) {
  const store = readState()
  const value = store[stateKey({ backend, accountId, windowType })]
  return value ? { ...value } : null
}

function listManualResetOverrides() {
  return { ...readOverrides() }
}

function setManualResetOverride({ backend, accountId, windowType, resetAt, note }) {
  const reset = parseDate(resetAt)
  if (!reset) {
    const err = new Error('invalid resetAt')
    err.status = 400
    throw err
  }
  const key = stateKey({ backend, accountId, windowType })
  const store = readOverrides()
  store[key] = note ? { resetAt: reset.toISOString(), note } : reset.toISOString()
  writeOverrides()
  return { key, value: store[key] }
}

function deleteManualResetOverride({ backend, accountId, windowType }) {
  const key = stateKey({ backend, accountId, windowType })
  const store = readOverrides()
  const existed = Object.prototype.hasOwnProperty.call(store, key)
  if (existed) {
    delete store[key]
    writeOverrides()
  }
  return { key, deleted: existed }
}

function manualResetAtFor({ backend, accountId, windowType, window }) {
  if (!window) return null
  const value = readOverrides()[stateKey({ backend, accountId, windowType })]
  const resetAt = parseDate(value && typeof value === 'object' ? value.resetAt : value)
  if (!resetAt) return null
  if (resetAt < window.start || resetAt > window.end) return null
  return resetAt
}

function applyManualResetOverride({ backend, accountId, windowType, window }) {
  if (!window) return null
  const manualResetAt = manualResetAtFor({ backend, accountId, windowType, window })
  if (!manualResetAt) return window
  const currentResetAt = parseDate(window.quotaResetAt)
  const effectiveResetAt =
    currentResetAt && currentResetAt > manualResetAt ? currentResetAt : manualResetAt
  return {
    ...window,
    start: effectiveResetAt > window.start ? effectiveResetAt : window.start,
    quotaResetAt: effectiveResetAt.toISOString(),
    quotaResetDetectedBy:
      currentResetAt && currentResetAt > manualResetAt
        ? window.quotaResetDetectedBy || null
        : 'manual_override'
  }
}

function setQuotaResetCursor({
  backend,
  accountId,
  windowType,
  resetsAt,
  lastUtilization,
  lastObservedAt,
  effectiveResetAt,
  effectiveResetSource,
  maxUtilization,
  maxObservedAt
}) {
  const store = readState()
  const key = stateKey({ backend, accountId, windowType })
  const previous = store[key] || {}
  const next = {
    resetsAt: iso(resetsAt) || previous.resetsAt || null,
    lastUtilization: finiteNumber(lastUtilization),
    lastObservedAt: iso(lastObservedAt) || previous.lastObservedAt || new Date().toISOString(),
    effectiveResetAt: iso(effectiveResetAt),
    effectiveResetSource: effectiveResetSource || null,
    maxUtilization: finiteNumber(maxUtilization),
    maxObservedAt: iso(maxObservedAt)
  }
  if (next.lastUtilization === null) {
    next.lastUtilization = finiteNumber(previous.lastUtilization)
  }
  if (next.maxUtilization === null) {
    next.maxUtilization = finiteNumber(previous.maxUtilization)
    if (next.maxUtilization === null) next.maxUtilization = next.lastUtilization
  }
  if (!next.maxObservedAt) {
    next.maxObservedAt = previous.maxObservedAt || next.lastObservedAt
  }
  if (JSON.stringify(previous) !== JSON.stringify(next)) {
    store[key] = next
    writeState()
  }
  return { ...next }
}

function applyQuotaResetCursor({
  backend,
  accountId,
  windowType,
  window,
  utilization,
  observedAt,
  now = new Date()
}) {
  if (!window) return null

  const store = readState()
  const key = stateKey({ backend, accountId, windowType })
  const resetsAtIso = iso(window.resetsAt)
  const currentUtil = finiteNumber(utilization)
  const observationTime = parseDate(observedAt) || now
  const previous = store[key]

  let effectiveResetAt = parseDate(previous && previous.effectiveResetAt)
  let effectiveResetSource = previous && previous.effectiveResetSource
  let staleUtilizationAfterReset = previous && previous.staleUtilizationAfterReset === true
  let staleUtilizationValue = finiteNumber(previous && previous.staleUtilizationValue)
  const previousUtil = finiteNumber(previous && previous.lastUtilization)
  let maxUtilization = finiteNumber(previous && previous.maxUtilization)
  let maxObservedAt = parseDate(previous && previous.maxObservedAt)
  const resetsChanged = previous && materiallyDifferentReset(previous.resetsAt, resetsAtIso)

  if (!ENABLE_UTILIZATION_DROP_RESETS && effectiveResetSource === 'utilization_drop') {
    effectiveResetAt = null
    effectiveResetSource = null
  }

  if (resetsChanged) {
    effectiveResetAt = null
    effectiveResetSource = null
    maxUtilization = currentUtil
    maxObservedAt = observationTime
    staleUtilizationAfterReset =
      windowType === 'sevenDay' &&
      previousUtil !== null &&
      currentUtil !== null &&
      currentUtil >= previousUtil - DROP_EPSILON
    staleUtilizationValue = staleUtilizationAfterReset ? currentUtil : null
  } else if (staleUtilizationAfterReset) {
    if (
      currentUtil === null ||
      (staleUtilizationValue !== null &&
        Math.abs(currentUtil - staleUtilizationValue) > DROP_EPSILON)
    ) {
      staleUtilizationAfterReset = false
      staleUtilizationValue = null
    }
  }
  if (!previous || maxUtilization === null) {
    maxUtilization = currentUtil
    maxObservedAt = observationTime
  }

  // Utilization drops are noisy for rolling 7d windows, so they are not reset
  // evidence unless explicitly enabled for a deployment.
  if (
    ENABLE_UTILIZATION_DROP_RESETS &&
    maxUtilization !== null &&
    !resetsChanged &&
    isSevenDayUtilizationReset(windowType, maxUtilization, currentUtil)
  ) {
    effectiveResetAt = observationTime
    effectiveResetSource = 'utilization_drop'
    maxUtilization = currentUtil
    maxObservedAt = observationTime
  } else if (
    currentUtil !== null &&
    (maxUtilization === null || currentUtil > maxUtilization + DROP_EPSILON)
  ) {
    maxUtilization = currentUtil
    maxObservedAt = observationTime
  }

  const resetBoundary = parseDate(window.resetsAt)
  if (resetBoundary && now >= resetBoundary) {
    const nextResetAt = latestDate(effectiveResetAt, resetBoundary)
    if (!effectiveResetAt || nextResetAt > effectiveResetAt) {
      effectiveResetSource = 'reset_boundary'
    }
    effectiveResetAt = nextResetAt
  }

  const next = {
    resetsAt: resetsAtIso,
    lastUtilization: currentUtil,
    lastObservedAt: observationTime.toISOString(),
    effectiveResetAt: effectiveResetAt ? effectiveResetAt.toISOString() : null,
    effectiveResetSource: effectiveResetSource || null,
    maxUtilization,
    maxObservedAt: maxObservedAt ? maxObservedAt.toISOString() : null,
    staleUtilizationAfterReset,
    staleUtilizationValue
  }
  if (JSON.stringify(previous || {}) !== JSON.stringify(next)) {
    store[key] = next
    writeState()
  }

  const effectiveStart =
    effectiveResetAt && effectiveResetAt > window.start ? effectiveResetAt : window.start

  return applyManualResetOverride({
    backend,
    accountId,
    windowType,
    window: {
    ...window,
    start: effectiveStart,
    quotaResetAt: effectiveResetAt ? effectiveResetAt.toISOString() : null,
    quotaResetDetectedBy: effectiveResetSource || null,
    staleUtilizationAfterReset
    }
  })
}

function utilizationForWindow(utilization, window, observedAt) {
  const currentUtil = finiteNumber(utilization)
  if (!window) return currentUtil

  const resetAt = parseDate(window.quotaResetAt)
  const observationTime = parseDate(observedAt)
  if (
    currentUtil !== null &&
    (
      window.staleUtilizationAfterReset ||
      (
        resetAt &&
        window.quotaResetDetectedBy === 'reset_boundary' &&
        observationTime &&
        observationTime <= resetAt
      )
    )
  ) {
    return 0
  }

  return currentUtil
}

module.exports = {
  applyQuotaResetCursor,
  getQuotaResetCursor,
  setQuotaResetCursor,
  applyManualResetOverride,
  listManualResetOverrides,
  setManualResetOverride,
  deleteManualResetOverride,
  utilizationForWindow,
  parseDate
}
