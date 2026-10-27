const express = require('express')
const fs = require('node:fs/promises')
const magpie = require('../backends/magpie')

module.exports = function makeMagpieRouter() {
  const router = express.Router()
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  const token = req => ((req.get('authorization') || '').match(/^Bearer\s+(.+)$/i) || [])[1] || ''
  async function isAdmin(req) {
    const file = process.env.MAGPIE_STATS_ADMIN_TOKEN_FILE
    return !!file && magpie.sameSecret(token(req), (await fs.readFile(file, 'utf8')).trim())
  }
  const handleError = (res, err) => res.status(err.status || 503).json({ error: err.status === 403 ? err.message : 'local data unavailable' })
  router.get('/health', async (req, res) => {
    try {
      const root = process.env.MAGPIE_DATA_DIR || '/config'
      for (const file of ['magpie/quotas.json', 'magpie/caller-keys.json', 'magpie/usage.jsonl', 'cache/magpie/models.json']) {
        await fs.access(require('node:path').join(root, file))
      }
      res.json({ ok: true, backend: 'magpie', store: 'local files only', ts: new Date().toISOString() })
    } catch (_) {
      res.status(503).json({ ok: false, backend: 'magpie', store: 'local files unavailable', ts: new Date().toISOString() })
    }
  })
  router.get('/key', async (req, res) => {
    try {
      const key = await magpie.authenticate(token(req))
      if (!key) return res.status(401).json({ error: 'unauthorized' })
      const reports = magpie.keyReports(await magpie.readSnapshot(), key)
      if (!reports.length) return res.status(404).json({ error: 'no attributable local account' })
      res.json(reports)
    } catch (err) { handleError(res, err) }
  })
  router.get('/accounts', async (req, res) => {
    try {
      if (!await isAdmin(req)) return res.status(401).json({ error: 'unauthorized' })
      const data = await magpie.readSnapshot()
      const accounts = data.accounts.map(a => magpie.fullReport(data, a).account)
      res.json({ count: accounts.length, accounts })
    } catch (err) { handleError(res, err) }
  })
  router.get('/account/:name', async (req, res) => {
    try {
      if (!await isAdmin(req)) return res.status(401).json({ error: 'unauthorized' })
      const data = await magpie.readSnapshot()
      const accounts = data.accounts.filter(a => a.account === req.params.name || a.account.replace(/^claude\//, '') === req.params.name)
      if (!accounts.length) return res.status(404).json({ error: 'account name not found' })
      res.json(accounts.map(a => magpie.fullReport(data, a)))
    } catch (err) { handleError(res, err) }
  })
  return router
}
