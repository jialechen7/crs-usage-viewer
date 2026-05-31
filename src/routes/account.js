const express = require('express')

// makeAccountRouter(backend) -> GET /account/:name (per-key usage in 5h/7d).
module.exports = function makeAccountRouter(backend) {
  const router = express.Router()

  router.get('/account/:name', async (req, res) => {
    try {
      const { found, reports } = await backend.accountReport(req.params.name, new Date())
      if (!found) {
        return res.status(404).json({ error: 'account name not found', name: req.params.name })
      }
      res.json(reports)
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
