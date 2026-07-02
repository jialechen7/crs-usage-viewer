const express = require('express')
const { round } = require('../lib/usageAggregator')

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 }
}

function addTokens(a, b) {
  return {
    input: a.input + (b && b.input ? b.input : 0),
    output: a.output + (b && b.output ? b.output : 0),
    cacheRead: a.cacheRead + (b && b.cacheRead ? b.cacheRead : 0),
    cacheCreate: a.cacheCreate + (b && b.cacheCreate ? b.cacheCreate : 0),
    total: a.total + (b && b.total ? b.total : 0)
  }
}

function parseTime(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function latestIso(...values) {
  let latest = null
  for (const value of values) {
    const d = parseTime(value)
    if (d && (!latest || d > latest)) latest = d
  }
  return latest ? latest.toISOString() : null
}

function earliestIso(...values) {
  let earliest = null
  for (const value of values) {
    const d = parseTime(value)
    if (d && (!earliest || d < earliest)) earliest = d
  }
  return earliest ? earliest.toISOString() : null
}

function utilizationFor(reports, windowType) {
  let picked = null
  const sources = []
  for (const r of reports) {
    const window = r.report.account && r.report.account[windowType]
    const utilization = window && window.utilization
    const source = {
      backend: r.backend,
      accountId: r.report.account && r.report.account.id,
      accountName: r.report.account && r.report.account.name,
      utilization: utilization == null ? null : utilization,
      resetsAt: window && window.resetsAt ? window.resetsAt : null,
      usageUpdatedAt: r.report.account && r.report.account.usageUpdatedAt
    }
    sources.push(source)
    if (utilization == null) continue
    const observedAt = parseTime(source.usageUpdatedAt) || new Date(0)
    if (!picked || observedAt > picked.observedAt) {
      picked = { ...source, observedAt }
    }
  }
  return {
    utilization: picked ? picked.utilization : null,
    source: picked
      ? {
          backend: picked.backend,
          accountId: picked.accountId,
          accountName: picked.accountName,
          usageUpdatedAt: picked.usageUpdatedAt,
          resetsAt: picked.resetsAt
        }
      : null,
    sources
  }
}

function keyMergeId(name, id) {
  const value = name || id || '(unknown)'
  return String(value).trim().toLowerCase()
}

function mergeWindow(reports, windowType) {
  const totalTokens = emptyTokens()
  const sourceTotals = []
  const keysByName = new Map()
  let totalCost = 0
  let requests = 0
  let activeHours = 0
  const starts = []
  const ends = []

  for (const r of reports) {
    const total = r.report.totals && r.report.totals[windowType]
    const window = r.report.account && r.report.account[windowType]
    const keys = (r.report.keys && r.report.keys[windowType]) || []
    const cost = total && Number.isFinite(Number(total.cost)) ? Number(total.cost) : 0

    totalCost += cost
    const nextTokens = addTokens(totalTokens, total && total.tokens)
    Object.assign(totalTokens, nextTokens)
    if (window && window.windowStart) starts.push(window.windowStart)
    if (window && window.windowEnd) ends.push(window.windowEnd)

    sourceTotals.push({
      backend: r.backend,
      accountId: r.report.account && r.report.account.id,
      accountName: r.report.account && r.report.account.name,
      cost: round(cost, 4),
      tokens: total && total.tokens ? total.tokens : emptyTokens(),
      utilization: window && window.utilization != null ? window.utilization : null,
      windowStart: window && window.windowStart ? window.windowStart : null,
      windowEnd: window && window.windowEnd ? window.windowEnd : null,
      resetsAt: window && window.resetsAt ? window.resetsAt : null
    })

    for (const key of keys) {
      const mergeId = keyMergeId(key.name, key.id)
      if (!keysByName.has(mergeId)) {
        keysByName.set(mergeId, {
          name: key.name || key.id || '(unknown)',
          aliases: new Set(),
          primaryCost: -1,
          cost: 0,
          tokens: emptyTokens(),
          requests: 0,
          activeHours: 0,
          sources: []
        })
      }
      const merged = keysByName.get(mergeId)
      const keyCost = Number.isFinite(Number(key.cost)) ? Number(key.cost) : 0
      if (key.name) merged.aliases.add(key.name)
      if (keyCost > merged.primaryCost) {
        merged.name = key.name || key.id || merged.name
        merged.primaryCost = keyCost
      }
      merged.cost += keyCost
      merged.tokens = addTokens(merged.tokens, key.tokens)
      merged.requests += key.requests || 0
      merged.activeHours += key.activeHours || 0
      requests += key.requests || 0
      activeHours += key.activeHours || 0
      merged.sources.push({
        backend: r.backend,
        accountId: r.report.account && r.report.account.id,
        accountName: r.report.account && r.report.account.name,
        keyId: key.id,
        keyName: key.name,
        isActive: key.isActive,
        cost: round(keyCost, 4),
        tokens: key.tokens || emptyTokens(),
        requests: key.requests || 0,
        activeHours: key.activeHours || 0,
        shareOfPlatformWindow: key.shareOfWindow,
        contributionToPlatformUtilization: key.contributionToUtilization
      })
    }
  }

  const { utilization, source, sources } = utilizationFor(reports, windowType)
  const keys = Array.from(keysByName.values())
    .map((key) => {
      const share = totalCost > 0 ? key.cost / totalCost : 0
      return {
        name: key.name,
        aliases: Array.from(key.aliases).sort(),
        cost: round(key.cost, 4),
        tokens: key.tokens,
        requests: key.requests,
        activeHours: key.activeHours,
        shareOfAccount: round(share, 8),
        accountUtilization: utilization,
        contributionToUtilization: utilization != null ? round(utilization * share, 4) : null,
        sources: key.sources.sort((a, b) => b.cost - a.cost)
      }
    })
    .sort((a, b) => b.cost - a.cost)

  return {
    windowStart: earliestIso(...starts),
    windowEnd: latestIso(...ends),
    cost: round(totalCost, 4),
    tokens: totalTokens,
    requests,
    activeHours,
    accountUtilization: utilization,
    utilizationSource: source,
    utilizationSources: sources,
    sourceTotals,
    keys
  }
}

async function reportsFromBackend(backend, backendName, name, now) {
  if (!backend || !name) return []
  const { found, reports } = await backend.accountReport(name, now, { effectiveWindows: false })
  if (!found) return []
  return reports.map((report) => ({ backend: backendName, report }))
}

module.exports = function makeAggregateRouter({ crs, crs2 }) {
  const router = express.Router()

  router.get('/account/:name', async (req, res) => {
    try {
      const now = new Date()
      const defaultName = req.params.name
      const crsName = req.query.crsName || defaultName
      const crs2Name = req.query.crs2Name || defaultName
      const [crsReports, crs2Reports] = await Promise.all([
        reportsFromBackend(crs, 'crs', crsName, now),
        reportsFromBackend(crs2, 'crs2', crs2Name, now)
      ])
      const reports = [...crsReports, ...crs2Reports]
      if (reports.length === 0) {
        return res.status(404).json({
          error: 'account name not found',
          name: defaultName,
          crsName,
          crs2Name
        })
      }

      res.json({
        account: {
          name: defaultName,
          windowMode: 'nominal',
          crsName,
          crs2Name,
          sourceAccounts: reports.map((r) => ({
            backend: r.backend,
            id: r.report.account && r.report.account.id,
            name: r.report.account && r.report.account.name,
            platform: r.report.account && r.report.account.platform,
            accountType: r.report.account && r.report.account.accountType,
            status: r.report.account && r.report.account.status,
            usageUpdatedAt: r.report.account && r.report.account.usageUpdatedAt
          }))
        },
        totals: {
          fiveHour: mergeWindow(reports, 'fiveHour'),
          sevenDay: mergeWindow(reports, 'sevenDay')
        }
      })
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
