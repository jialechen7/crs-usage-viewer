require('dotenv').config()
const express = require('express')

const healthRouter = require('./routes/health')
const accountsRouter = require('./routes/accounts')
const accountRouter = require('./routes/account').router
const keyRouter = require('./routes/key')
const docsRouter = require('./routes/docs')

const PORT = parseInt(process.env.PORT || '3001', 10)

const app = express()
app.disable('x-powered-by')
app.set('etag', false)

app.use('/stats', healthRouter)
app.use('/stats', accountsRouter)
app.use('/stats', accountRouter)
app.use('/stats', keyRouter)
app.use('/stats', docsRouter)

app.use((req, res) => {
  res.status(404).json({ error: 'not found', path: req.path })
})

app.listen(PORT, () => {
  console.log(`[crs-stats] listening on :${PORT}`)
})
