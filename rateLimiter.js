/**
 * rateLimiter.js - Per-Session Rate Limiting
 *
 * ANONYMITY GUARANTEE:
 * - Rate limit counters live only in memory (process RAM or Redis RAM).
 * - Counters are deleted when the session ends.
 */

const { REDIS_URL, getRedisClient } = require('./redisClient');

const MAX_MESSAGES_PER_WINDOW = 30; // Max messages per time window
const WINDOW_MS = 60 * 1000; // 1-minute sliding window

const USE_REDIS = !!REDIS_URL;
const rateLimits = new Map();

const KEYS = {
  rate: (sid) => `rate:${sid}`,
};

/**
 * Check if a session is allowed to send a message.
 * Returns true if allowed, false if rate-limited.
 */
async function isAllowed(sessionId) {
  const now = Date.now();

  if (!USE_REDIS) {
    let entry = rateLimits.get(sessionId);
    if (!entry || now - entry.windowStart > WINDOW_MS) {
      entry = { count: 1, windowStart: now };
      rateLimits.set(sessionId, entry);
      return true;
    }
    if (entry.count >= MAX_MESSAGES_PER_WINDOW) return false;
    entry.count++;
    return true;
  }

  const client = await getRedisClient();
  const raw = await client.get(KEYS.rate(sessionId));
  if (!raw) {
    await client.set(KEYS.rate(sessionId), JSON.stringify({ count: 1, windowStart: now }));
    return true;
  }

  const entry = JSON.parse(raw);
  if (now - entry.windowStart > WINDOW_MS) {
    await client.set(KEYS.rate(sessionId), JSON.stringify({ count: 1, windowStart: now }));
    return true;
  }

  if (entry.count >= MAX_MESSAGES_PER_WINDOW) {
    return false;
  }

  entry.count += 1;
  await client.set(KEYS.rate(sessionId), JSON.stringify(entry));
  return true;
}

/**
 * Remove rate limit data for a session (called on disconnect).
 */
async function clearLimit(sessionId) {
  if (!USE_REDIS) {
    rateLimits.delete(sessionId);
    return;
  }
  const client = await getRedisClient();
  await client.del(KEYS.rate(sessionId));
}

module.exports = {
  isAllowed,
  clearLimit,
};
