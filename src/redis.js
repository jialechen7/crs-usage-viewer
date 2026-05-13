const Redis = require('ioredis')

const client = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),
  enableReadyCheck: true,
  maxRetriesPerRequest: 3,
  lazyConnect: false
})

client.on('error', (err) => {
  console.error('[redis] error', err.message)
})

module.exports = client
