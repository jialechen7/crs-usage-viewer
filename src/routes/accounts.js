const express = require('express')

// makeAccountsRouter(backend) -> GET /accounts (account summaries).
module.exports = function makeAccountsRouter(backend) {
  const router = express.Router()

  router.get('/accounts', async (req, res) => {
    try {
      const accounts = await backend.listAccounts()
      res.json({ count: accounts.length, accounts })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
