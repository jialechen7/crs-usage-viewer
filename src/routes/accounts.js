const express = require('express')
const { listAllAccounts } = require('../lib/usageAggregator')

const router = express.Router()

router.get('/accounts', async (req, res) => {
  try {
    const all = await listAllAccounts()
    const data = all.map((a) => ({
      id: a.id,
      name: a.name,
      platform: a.platform,
      accountType: a.accountType,
      status: a.status,
      schedulable: a.schedulable === 'true' || a.schedulable === true,
      fiveHour: {
        resetsAt: a.claudeFiveHourResetsAt || null,
        utilization:
          a.claudeFiveHourUtilization !== undefined && a.claudeFiveHourUtilization !== ''
            ? Number(a.claudeFiveHourUtilization)
            : null
      },
      sevenDay: {
        resetsAt: a.claudeSevenDayResetsAt || null,
        utilization:
          a.claudeSevenDayUtilization !== undefined && a.claudeSevenDayUtilization !== ''
            ? Number(a.claudeSevenDayUtilization)
            : null,
        opusUtilization:
          a.claudeSevenDayOpusUtilization !== undefined && a.claudeSevenDayOpusUtilization !== ''
            ? Number(a.claudeSevenDayOpusUtilization)
            : null,
        opusResetsAt: a.claudeSevenDayOpusResetsAt || null
      },
      lastUsedAt: a.lastUsedAt || null,
      usageUpdatedAt: a.claudeUsageUpdatedAt || null
    }))
    res.json({ count: data.length, accounts: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
