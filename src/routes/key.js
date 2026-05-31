const express = require('express')

// makeKeyRouter(backend) -> GET /key/:identifier (by name or raw token).
module.exports = function makeKeyRouter(backend) {
  const router = express.Router()

  router.get('/key/:identifier', async (req, res) => {
    try {
      const { matches, mode } = await backend.keyReport(req.params.identifier, new Date())
      if (matches.length === 0) {
        return res.status(404).json({
          error: mode === 'token' ? 'api key token not found' : 'api key name not found',
          lookupMode: mode
        })
      }
      res.json(matches)
    } catch (err) {
      console.error(err)
      res.status(err.status || 500).json({ error: err.message })
    }
  })

  return router
}
