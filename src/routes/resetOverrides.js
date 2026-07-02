const express = require('express')
const {
  deleteManualResetOverride,
  listManualResetOverrides,
  setManualResetOverride
} = require('../lib/quotaResetTracker')

const DEFAULT_TIMEZONE_OFFSET_HOURS = Number(process.env.TIMEZONE_OFFSET || 8)
const ADMIN_TOKEN = process.env.RESET_OVERRIDE_ADMIN_TOKEN || ''
const WINDOW_MS = {
  fiveHour: 5 * 60 * 60 * 1000,
  sevenDay: 7 * 24 * 60 * 60 * 1000
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next()
  const auth = req.get('authorization') || ''
  const token = req.get('x-admin-token') || auth.replace(/^Bearer\s+/i, '')
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' })
  return next()
}

function parseLocalDate(value, timezoneOffsetHours) {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value

  const text = String(value).trim()
  const local = text.match(
    /^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})(?:[ T](\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/
  )
  if (local) {
    const [, y, mo, d, h = '0', mi = '0', s = '0'] = local
    const utcMs =
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) -
      timezoneOffsetHours * 3600000
    return new Date(utcMs)
  }

  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function windowTypeFrom(req) {
  const body = req.body || {}
  const value = body.windowType || req.query.windowType || 'sevenDay'
  if (value !== 'fiveHour' && value !== 'sevenDay') {
    const err = new Error('windowType must be fiveHour or sevenDay')
    err.status = 400
    throw err
  }
  return value
}

function timezoneOffsetFrom(req) {
  const body = req.body || {}
  const value = body.timezoneOffsetHours ?? req.query.timezoneOffsetHours
  const n = value == null || value === '' ? DEFAULT_TIMEZONE_OFFSET_HOURS : Number(value)
  if (!Number.isFinite(n)) {
    const err = new Error('timezoneOffsetHours must be a number')
    err.status = 400
    throw err
  }
  return n
}

function resetAtFrom(req) {
  const body = req.body || {}
  const resetAt = parseLocalDate(body.resetAt, timezoneOffsetFrom(req))
  if (!resetAt) {
    const err = new Error('resetAt is required and must be a valid date')
    err.status = 400
    throw err
  }
  return resetAt
}

function backendsFrom(req) {
  const body = req.body || {}
  const value = body.backends || req.query.backends
  if (!value) return null
  const list = Array.isArray(value) ? value : String(value).split(',')
  return new Set(list.map((x) => String(x).trim()).filter(Boolean))
}

async function accountReports(backend, backendName, name, now) {
  if (!backend || !name) return []
  const { found, reports } = await backend.accountReport(name, now, { effectiveWindows: false })
  if (!found) return []
  return reports.map((report) => ({
    backend: backendName,
    accountId: report.account && report.account.id,
    accountName: report.account && report.account.name
  }))
}

function parseOverrideKey(key) {
  const [backend, accountId, windowType] = String(key).split(':')
  return { backend, accountId, windowType }
}

function resetAtFromOverride(value) {
  return value && typeof value === 'object' ? value.resetAt : value
}

function noteFromOverride(value) {
  return value && typeof value === 'object' ? value.note || null : null
}

function iso(value) {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null
}

function localIso(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return null
  return date.toLocaleString('sv-SE', {
    timeZone: 'Asia/Shanghai',
    hour12: false
  })
}

function normalResetAt(account, windowType) {
  const resetsAt = account && account[windowType] && account[windowType].resetsAt
  const resetsDate = resetsAt ? new Date(resetsAt) : null
  if (!resetsDate || Number.isNaN(resetsDate.getTime())) return null
  return new Date(resetsDate.getTime() - WINDOW_MS[windowType])
}

function effectiveManualResetAt(manualResetAt, normalResetAt, nextResetsAt) {
  const manual = manualResetAt ? new Date(manualResetAt) : null
  if (!manual || Number.isNaN(manual.getTime())) return null
  const normal = normalResetAt ? new Date(normalResetAt) : null
  const next = nextResetsAt ? new Date(nextResetsAt) : null
  if (normal && manual < normal) return null
  if (next && manual > next) return null
  if (normal && manual.getTime() === normal.getTime()) return null
  return manual.toISOString()
}

async function accountsById(backend) {
  if (!backend || typeof backend.listAccounts !== 'function') return new Map()
  const accounts = await backend.listAccounts()
  return new Map(accounts.map((account) => [String(account.id), account]))
}

async function accountsList(backend) {
  if (!backend || typeof backend.listAccounts !== 'function') return []
  return backend.listAccounts()
}

async function hydrateOverrides(overrides, { crs, crs2 }) {
  const [crsAccounts, crs2Accounts] = await Promise.all([
    accountsById(crs),
    accountsById(crs2)
  ])
  const accounts = { crs: crsAccounts, crs2: crs2Accounts }
  return Object.entries(overrides).map(([key, value]) => {
    const target = parseOverrideKey(key)
    const account = accounts[target.backend] && accounts[target.backend].get(String(target.accountId))
    return {
      key,
      backend: target.backend,
      accountId: target.accountId,
      accountName: account ? account.name : null,
      platform: account ? account.platform : null,
      windowType: target.windowType,
      resetAt: resetAtFromOverride(value),
      resetAtLocal: localIso(resetAtFromOverride(value)),
      note: noteFromOverride(value)
    }
  })
}

async function accountResetItems({ crs, crs2, overrides, windowType, wanted }) {
  const sources = [
    { name: 'crs', backend: crs },
    { name: 'crs2', backend: crs2 }
  ].filter((source) => source.backend && (!wanted || wanted.has(source.name)))

  const lists = await Promise.all(sources.map((source) => accountsList(source.backend)))
  const seen = new Set()
  const items = []

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]
    for (const account of lists[i]) {
      const key = `${source.name}:${account.id}:${windowType}`
      seen.add(key)
      const override = overrides[key]
      const manualResetAt = iso(resetAtFromOverride(override))
      const normalAt = iso(normalResetAt(account, windowType))
      const nextResetsAt = account[windowType] && account[windowType].resetsAt
        ? account[windowType].resetsAt
        : null
      const activeManualResetAt = effectiveManualResetAt(manualResetAt, normalAt, nextResetsAt)
      const resetAt = activeManualResetAt || normalAt
      items.push({
        key,
        backend: source.name,
        accountId: String(account.id),
        accountName: account.name || null,
        platform: account.platform || null,
        accountType: account.accountType || null,
        status: account.status || null,
        windowType,
        resetAt,
        resetAtLocal: localIso(resetAt),
        resetSource: activeManualResetAt ? 'manual_override' : 'normal',
        normalResetAt: normalAt,
        normalResetAtLocal: localIso(normalAt),
        manualResetAt,
        manualResetAtLocal: localIso(manualResetAt),
        hasOverride: Boolean(manualResetAt),
        overrideActive: Boolean(activeManualResetAt),
        nextResetsAt,
        nextResetsAtLocal: localIso(nextResetsAt),
        utilization: account[windowType] && account[windowType].utilization != null
          ? account[windowType].utilization
          : null,
        note: noteFromOverride(override)
      })
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    const target = parseOverrideKey(key)
    if (target.windowType !== windowType || seen.has(key)) continue
    if (wanted && !wanted.has(target.backend)) continue
    const resetAt = iso(resetAtFromOverride(value))
    items.push({
      key,
      backend: target.backend,
      accountId: target.accountId,
      accountName: null,
      platform: null,
      accountType: null,
      status: null,
      windowType: target.windowType,
      resetAt,
      resetAtLocal: localIso(resetAt),
      resetSource: 'manual_override',
      hasOverride: true,
      nextResetsAt: null,
      nextResetsAtLocal: null,
      utilization: null,
      note: noteFromOverride(value)
    })
  }

  return items.sort((a, b) => {
    const byBackend = a.backend.localeCompare(b.backend)
    if (byBackend) return byBackend
    const byName = String(a.accountName || '').localeCompare(String(b.accountName || ''))
    if (byName) return byName
    return String(a.accountId).localeCompare(String(b.accountId))
  })
}

function directTarget(req) {
  const body = req.body || {}
  const backend = body.backend || req.query.backend
  const accountId = body.accountId || req.query.accountId
  const windowType = windowTypeFrom(req)
  if (!backend || !accountId) {
    const err = new Error('backend and accountId are required')
    err.status = 400
    throw err
  }
  return { backend, accountId, windowType }
}

module.exports = function makeResetOverridesRouter({ crs, crs2 }) {
  const router = express.Router()

  router.get('/', requireAdmin, async (req, res) => {
    try {
      const windowType = windowTypeFrom(req)
      const wanted = backendsFrom(req)
      const overrides = listManualResetOverrides()
      const [items, overrideItems] = await Promise.all([
        accountResetItems({ crs, crs2, overrides, windowType, wanted }),
        hydrateOverrides(overrides, { crs, crs2 })
      ])
      res.json({
        count: items.length,
        windowType,
        items,
        overrideCount: overrideItems.length,
        overrideItems,
        overrides
      })
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message })
    }
  })

  router.put('/', requireAdmin, (req, res) => {
    try {
      const body = req.body || {}
      const target = directTarget(req)
      const resetAt = resetAtFrom(req)
      const result = setManualResetOverride({
        ...target,
        resetAt,
        note: body.note || undefined
      })
      res.json({ ok: true, resetAt: resetAt.toISOString(), result })
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message })
    }
  })

  router.delete('/', requireAdmin, (req, res) => {
    try {
      const result = deleteManualResetOverride(directTarget(req))
      res.json({ ok: true, result })
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message })
    }
  })

  router.put('/account/:name', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {}
      const now = new Date()
      const defaultName = req.params.name
      const crsName = body.crsName || req.query.crsName || defaultName
      const crs2Name = body.crs2Name || req.query.crs2Name || defaultName
      const wanted = backendsFrom(req)
      const windowType = windowTypeFrom(req)
      const resetAt = resetAtFrom(req)
      const note = body.note || undefined

      const [crsReports, crs2Reports] = await Promise.all([
        !wanted || wanted.has('crs') ? accountReports(crs, 'crs', crsName, now) : [],
        !wanted || wanted.has('crs2') ? accountReports(crs2, 'crs2', crs2Name, now) : []
      ])
      const targets = [...crsReports, ...crs2Reports]
      if (targets.length === 0) {
        return res.status(404).json({ error: 'account name not found', name: defaultName })
      }
      const results = targets.map((target) =>
        setManualResetOverride({
          backend: target.backend,
          accountId: target.accountId,
          windowType,
          resetAt,
          note
        })
      )
      res.json({ ok: true, resetAt: resetAt.toISOString(), targets, results })
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message })
    }
  })

  router.delete('/account/:name', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {}
      const now = new Date()
      const defaultName = req.params.name
      const crsName = body.crsName || req.query.crsName || defaultName
      const crs2Name = body.crs2Name || req.query.crs2Name || defaultName
      const wanted = backendsFrom(req)
      const windowType = windowTypeFrom(req)
      const [crsReports, crs2Reports] = await Promise.all([
        !wanted || wanted.has('crs') ? accountReports(crs, 'crs', crsName, now) : [],
        !wanted || wanted.has('crs2') ? accountReports(crs2, 'crs2', crs2Name, now) : []
      ])
      const targets = [...crsReports, ...crs2Reports]
      const results = targets.map((target) =>
        deleteManualResetOverride({
          backend: target.backend,
          accountId: target.accountId,
          windowType
        })
      )
      res.json({ ok: true, targets, results })
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message })
    }
  })

  return router
}
