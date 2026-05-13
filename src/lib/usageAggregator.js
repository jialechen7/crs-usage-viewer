const redis = require('../redis')
const { iterHourKeys } = require('./windowResolver')

async function listAllAccounts() {
  const keys = await redis.keys('claude:account:*')
  const ids = keys
    .map((k) => k.replace(/^claude:account:/, ''))
    .filter((id) => id && id !== 'index')
  if (ids.length === 0) return []
  const pipeline = redis.pipeline()
  ids.forEach((id) => pipeline.hgetall(`claude:account:${id}`))
  const res = await pipeline.exec()
  return ids
    .map((id, i) => {
      const [, hash] = res[i]
      if (!hash || Object.keys(hash).length === 0) return null
      return { id, ...hash }
    })
    .filter(Boolean)
}

async function findAccountsByName(name) {
  const all = await listAllAccounts()
  return all.filter((a) => a.name === name)
}

async function listAllApiKeys() {
  const keys = await redis.keys('apikey:*')
  if (keys.length === 0) return []
  const pipeline = redis.pipeline()
  keys.forEach((k) => pipeline.hgetall(k))
  const res = await pipeline.exec()
  return keys
    .map((k, i) => {
      const [, hash] = res[i]
      if (!hash || Object.keys(hash).length === 0) return null
      const id = k.replace(/^apikey:/, '')
      return { id, ...hash }
    })
    .filter(Boolean)
}

async function findKeysBoundToAccount(accountId) {
  const all = await listAllApiKeys()
  return all.filter(
    (k) => k.claudeAccountId === accountId || k.claudeConsoleAccountId === accountId
  )
}

async function findKeysByName(name) {
  const all = await listAllApiKeys()
  return all.filter((k) => k.name === name)
}

function emptyUsage() {
  return {
    cost: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
    requests: 0,
    activeHours: 0
  }
}

async function aggregateKeyUsage(keyId, window) {
  if (!window) return emptyUsage()
  const hours = iterHourKeys(window.start, window.end)
  if (hours.length === 0) return emptyUsage()

  const pipeline = redis.pipeline()
  for (const { date, hour } of hours) {
    pipeline.get(`usage:cost:hourly:${keyId}:${date}:${hour}`)
    pipeline.hgetall(`usage:hourly:${keyId}:${date}:${hour}`)
  }
  const res = await pipeline.exec()

  const out = emptyUsage()
  for (let i = 0; i < hours.length; i++) {
    const [, costVal] = res[i * 2]
    const [, tokenHash] = res[i * 2 + 1]
    if (costVal) {
      const c = parseFloat(costVal)
      if (!Number.isNaN(c)) {
        out.cost += c
        out.activeHours += 1
      }
    }
    if (tokenHash && Object.keys(tokenHash).length > 0) {
      out.tokens.input += parseInt(tokenHash.inputTokens || '0', 10) || 0
      out.tokens.output += parseInt(tokenHash.outputTokens || '0', 10) || 0
      out.tokens.cacheRead += parseInt(tokenHash.cacheReadTokens || '0', 10) || 0
      out.tokens.cacheCreate += parseInt(tokenHash.cacheCreateTokens || '0', 10) || 0
      out.requests += parseInt(tokenHash.requests || '0', 10) || 0
    }
  }
  out.tokens.total =
    out.tokens.input + out.tokens.output + out.tokens.cacheRead + out.tokens.cacheCreate
  return out
}

function round(x, n = 4) {
  if (!Number.isFinite(x)) return 0
  const m = Math.pow(10, n)
  return Math.round(x * m) / m
}

module.exports = {
  listAllAccounts,
  findAccountsByName,
  listAllApiKeys,
  findKeysBoundToAccount,
  findKeysByName,
  aggregateKeyUsage,
  emptyUsage,
  round
}
