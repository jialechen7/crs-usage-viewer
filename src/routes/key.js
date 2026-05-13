const express = require('express')
const redis = require('../redis')
const {
  findKeysByName,
  findKeysBoundToAccount,
  aggregateKeyUsage,
  round
} = require('../lib/usageAggregator')
const { resolveFiveHourWindow, resolveSevenDayWindow } = require('../lib/windowResolver')
const { looksLikeToken, resolveKeyIdByToken, loadKeyById } = require('../lib/apiKeyResolver')

const router = express.Router()

async function loadAccountHash(accountId) {
  if (!accountId) return null
  const hash = await redis.hgetall(`claude:account:${accountId}`)
  if (!hash || Object.keys(hash).length === 0) return null
  return { id: accountId, ...hash }
}

function pickUtilization(account, windowType) {
  const field =
    windowType === 'fiveHour' ? account.claudeFiveHourUtilization : account.claudeSevenDayUtilization
  if (field === undefined || field === '') return null
  const n = Number(field)
  return Number.isFinite(n) ? n : null
}

function emptyWindowReport() {
  return {
    windowStart: null,
    windowEnd: null,
    resetsAt: null,
    cost: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
    requests: 0,
    activeHours: 0,
    accountTotalCost: 0,
    shareOfAccount: null,
    accountUtilization: null,
    contributionToUtilization: null
  }
}

async function buildWindowReport(keyRow, account, window, windowType) {
  if (!account || !window) return emptyWindowReport()

  const myUsage = await aggregateKeyUsage(keyRow.id, window)

  const sibKeys = await findKeysBoundToAccount(account.id)
  let accountTotal = 0
  for (const sib of sibKeys) {
    if (sib.id === keyRow.id) {
      accountTotal += myUsage.cost
    } else {
      const u = await aggregateKeyUsage(sib.id, window)
      accountTotal += u.cost
    }
  }

  const utilization = pickUtilization(account, windowType)
  const share = accountTotal > 0 ? myUsage.cost / accountTotal : 0

  return {
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    resetsAt: window.resetsAt.toISOString(),
    cost: round(myUsage.cost, 4),
    tokens: myUsage.tokens,
    requests: myUsage.requests,
    activeHours: myUsage.activeHours,
    accountTotalCost: round(accountTotal, 4),
    shareOfAccount: round(share, 6),
    accountUtilization: utilization,
    contributionToUtilization: utilization !== null ? round(utilization * share, 4) : null
  }
}

async function resolveMatches(identifier) {
  if (looksLikeToken(identifier)) {
    try {
      const keyId = await resolveKeyIdByToken(identifier)
      if (!keyId) return { matches: [], mode: 'token' }
      const key = await loadKeyById(keyId)
      return { matches: key ? [key] : [], mode: 'token' }
    } catch (err) {
      const e = new Error(`token lookup failed: ${err.message}`)
      e.status = 500
      throw e
    }
  }
  return { matches: await findKeysByName(identifier), mode: 'name' }
}

router.get('/key/:identifier', async (req, res) => {
  try {
    const { matches, mode } = await resolveMatches(req.params.identifier)
    if (matches.length === 0) {
      return res.status(404).json({
        error: mode === 'token' ? 'api key token not found' : 'api key name not found',
        lookupMode: mode
      })
    }
    const now = new Date()
    const reports = []
    for (const k of matches) {
      const accountId = k.claudeAccountId || k.claudeConsoleAccountId || null
      const account = await loadAccountHash(accountId)
      const fiveHourWindow = account ? resolveFiveHourWindow(account, now) : null
      const sevenDayWindow = account ? resolveSevenDayWindow(account, now) : null

      reports.push({
        key: {
          id: k.id,
          name: k.name,
          isActive: k.isActive === 'true' || k.isActive === true,
          accountId,
          accountName: account ? account.name : null
        },
        fiveHour: await buildWindowReport(k, account, fiveHourWindow, 'fiveHour'),
        sevenDay: await buildWindowReport(k, account, sevenDayWindow, 'sevenDay')
      })
    }
    res.json(reports)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
