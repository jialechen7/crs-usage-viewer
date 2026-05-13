const crypto = require('crypto')
const redis = require('../redis')

const API_KEY_PREFIX = process.env.API_KEY_PREFIX || 'cr_'

function looksLikeToken(s) {
  return typeof s === 'string' && s.startsWith(API_KEY_PREFIX)
}

function hashApiKey(rawKey) {
  const encryptionKey = process.env.ENCRYPTION_KEY
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY not configured; cannot resolve raw cr_ token')
  }
  return crypto.createHash('sha256').update(rawKey + encryptionKey).digest('hex')
}

async function resolveKeyIdByToken(rawKey) {
  const hashed = hashApiKey(rawKey)
  return redis.hget('apikey:hash_map', hashed)
}

async function loadKeyById(keyId) {
  if (!keyId) return null
  const hash = await redis.hgetall(`apikey:${keyId}`)
  if (!hash || Object.keys(hash).length === 0) return null
  return { id: keyId, ...hash }
}

module.exports = { looksLikeToken, hashApiKey, resolveKeyIdByToken, loadKeyById }
