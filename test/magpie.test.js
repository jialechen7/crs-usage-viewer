const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-viewer-test-'))
fs.mkdirSync(path.join(tmp, 'magpie'), { recursive: true })
fs.mkdirSync(path.join(tmp, 'cache/magpie'), { recursive: true })
const write = (file, data) => fs.writeFileSync(path.join(tmp, file), JSON.stringify(data))
const now = Date.now()
const iso = n => new Date(n).toISOString()
write('magpie/quotas.json', { 'claude/account@example.com': { quota: { provider: 'claude', plan: 'max', readAt: iso(now), windows: [
  { name: '5 hours', used: 20, resetsAt: iso(now + 3600000) },
  { name: '7 days', used: 40, resetsAt: iso(now + 86400000) }
] } } })
write('magpie/caller-keys.json', [
  { id: 'one', name: 'one', secret: 'secret-one' },
  { id: 'two', name: 'two', secret: 'secret-two' },
  { id: 'disabled', name: 'disabled', secret: 'secret-off', off: true },
  { id: 'restricted', name: 'restricted', secret: 'secret-limited', models: ['claude/other'] }
])
write('cache/magpie/models.json', { anthropic: { models: { sonnet: { cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 } } } } })
const base = { t: iso(now - 1000), provider: 'claude', providerAccount: 'account@example.com', served: 'sonnet', status: 200 }
fs.writeFileSync(path.join(tmp, 'magpie/usage.jsonl'), [
  { ...base, callerKeyId: 'one', callerKeyName: 'one', in: 100 },
  { ...base, callerKeyId: 'two', callerKeyName: 'two', in: 300 }
].map(JSON.stringify).join('\n') + '\n')
fs.writeFileSync(path.join(tmp, 'admin'), 'admin-secret-long-enough')
process.env.ENABLE_CRS = 'false'
process.env.ENABLE_CRS2 = 'false'
process.env.ENABLE_MAGPIE = 'true'
process.env.MAGPIE_DATA_DIR = tmp
process.env.MAGPIE_STATS_ADMIN_TOKEN_FILE = path.join(tmp, 'admin')
const app = require('../src/server')

test('Magpie compatible API authenticates, scopes and does not need Redis', async () => {
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const get = (route, token) => fetch(baseUrl + route, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  try {
    assert.equal((await get('/stats/magpie/key')).status, 401)
    assert.equal((await get('/stats/magpie/key', 'secret-off')).status, 401)
    assert.equal((await get('/stats/magpie/key', 'secret-limited')).status, 403)
    assert.equal((await get('/stats/magpie/account/account%40example.com', 'secret-one')).status, 401)
    const response = await get('/stats/magpie/key', 'secret-one')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const [report] = await response.json()
    assert.equal(report.key.id, 'one')
    assert.equal(report.fiveHour.shareOfAccount, 0.25)
    assert.equal(report.fiveHour.contributionToUtilization, 5)
    assert.equal(report.sevenDay.contributionToUtilization, 10)
    assert.equal(report.dataQuality.costType, 'estimated_api_equivalent')
    assert.equal(JSON.stringify(report).includes('secret-one'), false)
    assert.equal(JSON.stringify(report).includes('secret-two'), false)
    const admin = await get('/stats/magpie/account/account%40example.com', 'admin-secret-long-enough')
    assert.equal(admin.status, 200)
    const [account] = await admin.json()
    assert.equal(account.keys.fiveHour.find(k => k.id === 'two').shareOfWindow, 0.75)
  } finally {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
