const express = require('express')

// makeHealthRouter(backend) -> GET /health probe for the given backend.
module.exports = function makeHealthRouter(backend) {
  const router = express.Router()

  router.get('/health', async (req, res) => {
    const { ok, detail } = await backend.health()
    const body = { ok, backend: backend.name, store: detail, ts: new Date().toISOString() }
    // Backward-compatible alias: the original crs /stats/health exposed `redis`.
    if (backend.name === 'crs') body.redis = detail
    res.json(body)
  })

  return router
}
