const express = require('express')
const {
  findAccountsByName,
  findKeysBoundToAccount,
  aggregateKeyUsage,
  round
} = require('../lib/usageAggregator')
const { resolveFiveHourWindow, resolveSevenDayWindow } = require('../lib/windowResolver')

const router = express.Router()

function summarizeWindow(window) {
  if (!window) return null
  return {
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    resetsAt: window.resetsAt.toISOString()
  }
}

async function buildAccountReport(account, now) {
  const fiveHourWindow = resolveFiveHourWindow(account, now)
  const sevenDayWindow = resolveSevenDayWindow(account, now)

  const keys = await findKeysBoundToAccount(account.id)

  const collect = async (window) => {
    const items = []
    for (const k of keys) {
      const usage = await aggregateKeyUsage(k.id, window)
      items.push({
        id: k.id,
        name: k.name,
        isActive: k.isActive === 'true' || k.isActive === true,
        ...usage,
        cost: round(usage.cost, 4)
      })
    }
    const totalCost = items.reduce((s, x) => s + x.cost, 0)
    const totalTokens = items.reduce(
      (s, x) => ({
        input: s.input + x.tokens.input,
        output: s.output + x.tokens.output,
        cacheRead: s.cacheRead + x.tokens.cacheRead,
        cacheCreate: s.cacheCreate + x.tokens.cacheCreate,
        total: s.total + x.tokens.total
      }),
      { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 }
    )
    for (const item of items) {
      item.shareOfWindow = totalCost > 0 ? round(item.cost / totalCost, 6) : 0
    }
    return { items, totalCost: round(totalCost, 4), totalTokens }
  }

  const fiveHour = await collect(fiveHourWindow)
  const sevenDay = await collect(sevenDayWindow)

  const fiveHourUtilization =
    account.claudeFiveHourUtilization !== undefined && account.claudeFiveHourUtilization !== ''
      ? Number(account.claudeFiveHourUtilization)
      : null
  const sevenDayUtilization =
    account.claudeSevenDayUtilization !== undefined && account.claudeSevenDayUtilization !== ''
      ? Number(account.claudeSevenDayUtilization)
      : null

  for (const item of fiveHour.items) {
    item.contributionToUtilization =
      fiveHourUtilization !== null ? round(fiveHourUtilization * item.shareOfWindow, 4) : null
  }
  for (const item of sevenDay.items) {
    item.contributionToUtilization =
      sevenDayUtilization !== null ? round(sevenDayUtilization * item.shareOfWindow, 4) : null
  }

  return {
    account: {
      id: account.id,
      name: account.name,
      platform: account.platform,
      accountType: account.accountType,
      status: account.status,
      fiveHour: {
        ...summarizeWindow(fiveHourWindow),
        utilization: fiveHourUtilization
      },
      sevenDay: {
        ...summarizeWindow(sevenDayWindow),
        utilization: sevenDayUtilization,
        opusUtilization:
          account.claudeSevenDayOpusUtilization !== undefined &&
          account.claudeSevenDayOpusUtilization !== ''
            ? Number(account.claudeSevenDayOpusUtilization)
            : null
      },
      usageUpdatedAt: account.claudeUsageUpdatedAt || null
    },
    keys: {
      fiveHour: fiveHour.items.sort((a, b) => b.cost - a.cost),
      sevenDay: sevenDay.items.sort((a, b) => b.cost - a.cost)
    },
    totals: {
      fiveHour: { cost: fiveHour.totalCost, tokens: fiveHour.totalTokens },
      sevenDay: { cost: sevenDay.totalCost, tokens: sevenDay.totalTokens }
    }
  }
}

router.get('/account/:name', async (req, res) => {
  try {
    const matches = await findAccountsByName(req.params.name)
    if (matches.length === 0) {
      return res.status(404).json({ error: 'account name not found', name: req.params.name })
    }
    const now = new Date()
    const reports = []
    for (const acc of matches) {
      reports.push(await buildAccountReport(acc, now))
    }
    res.json(reports)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

module.exports = { router, buildAccountReport }
