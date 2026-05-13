const express = require('express')
const redis = require('../redis')

const router = express.Router()

router.get('/health', async (req, res) => {
  let redisStatus = 'unknown'
  try {
    const pong = await redis.ping()
    redisStatus = pong === 'PONG' ? 'connected' : 'unexpected'
  } catch (err) {
    redisStatus = `error: ${err.message}`
  }
  res.json({ ok: redisStatus === 'connected', redis: redisStatus, ts: new Date().toISOString() })
})

module.exports = router
