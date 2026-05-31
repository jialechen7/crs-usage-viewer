// Lazy Postgres pool for the crs2 (sub2api) backend.
// Only instantiated when something actually queries crs2, so a pure-CRS
// deployment never needs pg configured or even reachable.
let Pool
let pool = null

function getPool() {
  if (pool) return pool
  if (!Pool) {
    // require lazily so `pg` not being installed doesn't break the crs path
    Pool = require('pg').Pool
  }
  pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    user: process.env.PG_USER || 'sub2api',
    password: process.env.PG_PASSWORD || undefined,
    database: process.env.PG_DATABASE || 'sub2api',
    ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: parseInt(process.env.PG_POOL_MAX || '5', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  })
  pool.on('error', (err) => {
    console.error('[pg] pool error', err.message)
  })
  return pool
}

function query(text, params) {
  return getPool().query(text, params)
}

module.exports = { getPool, query }
