require('dotenv').config()
const express = require('express')

const makeHealthRouter = require('./routes/health')
const makeAccountsRouter = require('./routes/accounts')
const makeAccountRouter = require('./routes/account')
const makeKeyRouter = require('./routes/key')
const makeDocsRouter = require('./routes/docs')

const PORT = parseInt(process.env.PORT || '3001', 10)
const ENABLE_CRS2 = process.env.ENABLE_CRS2 === 'true'

const app = express()
app.disable('x-powered-by')
app.set('etag', false)

// Mount one backend's full set of routes under a base path.
function mountBackend(basePath, backend) {
  app.use(basePath, makeHealthRouter(backend))
  app.use(basePath, makeAccountsRouter(backend))
  app.use(basePath, makeAccountRouter(backend))
  app.use(basePath, makeKeyRouter(backend))
  app.use(basePath, makeDocsRouter(backend, basePath))
  if (typeof backend.startQuotaSampler === 'function') {
    backend.startQuotaSampler()
  }
}

// crs2 first so /stats/crs2/* is resolved before the crs /stats/* routes.
if (ENABLE_CRS2) {
  mountBackend('/stats/crs2', require('./backends/crs2'))
}
mountBackend('/stats', require('./backends/crs'))

app.use((req, res) => {
  res.status(404).json({ error: 'not found', path: req.path })
})

app.listen(PORT, () => {
  console.log(`[crs-stats] listening on :${PORT} (crs2 ${ENABLE_CRS2 ? 'enabled' : 'disabled'})`)
})
