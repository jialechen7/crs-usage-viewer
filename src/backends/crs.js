// crs backend: reads CRS (claude-relay-service) usage straight from Redis.
// Implements the shared backend interface consumed by the route factories.
const redis = require('../redis')
const {
  listAllAccounts,
  findAccountsByName,
  findKeysBoundToAccount,
  findKeysByName,
  aggregateKeyUsage,
  round
} = require('../lib/usageAggregator')
const { resolveFiveHourWindow, resolveSevenDayWindow } = require('../lib/windowResolver')
const { looksLikeToken, resolveKeyIdByToken, loadKeyById } = require('../lib/apiKeyResolver')
const { summarizeAccount } = require('../lib/accountSerializer')

async function health() {
  try {
    const pong = await redis.ping()
    const ok = pong === 'PONG'
    return { ok, detail: ok ? 'connected' : 'unexpected' }
  } catch (err) {
    return { ok: false, detail: `error: ${err.message}` }
  }
}

async function listAccounts() {
  const all = await listAllAccounts()
  return all.map((a) => ({
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
}

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
      item.shareOfWindow = totalCost > 0 ? round(item.cost / totalCost, 8) : 0
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

async function accountReport(name, now) {
  const matches = await findAccountsByName(name)
  if (matches.length === 0) return { found: false, reports: [] }
  const reports = []
  for (const acc of matches) {
    reports.push(await buildAccountReport(acc, now))
  }
  return { found: true, reports }
}

async function loadAccountHash(accountId) {
  if (!accountId) return null
  const hash = await redis.hgetall(`claude:account:${accountId}`)
  if (!hash || Object.keys(hash).length === 0) return null
  return { id: accountId, ...hash }
}

function pickUtilization(account, windowType) {
  const field =
    windowType === 'fiveHour'
      ? account.claudeFiveHourUtilization
      : account.claudeSevenDayUtilization
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
    shareOfAccount: round(share, 8),
    accountUtilization: utilization,
    contributionToUtilization: utilization !== null ? round(utilization * share, 4) : null
  }
}

async function resolveKeyMatches(identifier) {
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

async function keyReport(identifier, now) {
  const { matches, mode } = await resolveKeyMatches(identifier)
  if (matches.length === 0) return { matches: [], mode }
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
      account: summarizeAccount(account),
      fiveHour: await buildWindowReport(k, account, fiveHourWindow, 'fiveHour'),
      sevenDay: await buildWindowReport(k, account, sevenDayWindow, 'sevenDay')
    })
  }
  return { matches: reports, mode }
}

module.exports = {
  name: 'crs',
  health,
  listAccounts,
  accountReport,
  keyReport
}
