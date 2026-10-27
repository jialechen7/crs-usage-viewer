require('dotenv').config()
const express = require('express')

const makeHealthRouter = require('./routes/health')
const makeAccountsRouter = require('./routes/accounts')
const makeAccountRouter = require('./routes/account')
const makeKeyRouter = require('./routes/key')
const makeDocsRouter = require('./routes/docs')
const PORT = parseInt(process.env.PORT || '3001', 10)
const HOST = process.env.HOST || '0.0.0.0'
const ENABLE_CRS = process.env.ENABLE_CRS !== 'false'
const ENABLE_CRS2 = process.env.ENABLE_CRS2 === 'true'
const ENABLE_MAGPIE = process.env.ENABLE_MAGPIE === 'true'

const app = express()
app.disable('x-powered-by')
app.set('etag', false)
app.use(express.json({ limit: '64kb' }))

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
const crsBackend = ENABLE_CRS ? require('./backends/crs') : null
const crs2Backend = ENABLE_CRS2 ? require('./backends/crs2') : null
if (ENABLE_MAGPIE) {
  app.use('/stats/magpie', require('./routes/magpie')())
}
if (ENABLE_CRS2) {
  mountBackend('/stats/crs2', crs2Backend)
}
if (ENABLE_CRS) {
  const makeAggregateRouter = require('./routes/aggregate')
  const makeResetOverridesRouter = require('./routes/resetOverrides')
  app.use('/stats/aggregate', makeAggregateRouter({ crs: crsBackend, crs2: crs2Backend }))
  app.use('/stats/reset-overrides', makeResetOverridesRouter({ crs: crsBackend, crs2: crs2Backend }))
  mountBackend('/stats', crsBackend)
}

app.use((req, res) => {
  res.status(404).json({ error: 'not found', path: req.path })
})

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`[crs-stats] listening on ${HOST}:${PORT} (crs ${ENABLE_CRS}, crs2 ${ENABLE_CRS2}, magpie ${ENABLE_MAGPIE})`)
  })
}

module.exports = app
