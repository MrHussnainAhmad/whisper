/** Small in-memory limiter for the public HTTP probe routes. Socket abuse
 * controls are handled separately in abuseLimiter.js. No source values are
 * logged or persisted. */
const { normalizeSource } = require('./abuseLimiter');
const crypto = require('crypto');

const WINDOW_MS = 60_000;
function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
const SOURCE_LIMIT = positiveIntegerEnv('HTTP_REQUESTS_PER_SOURCE', 120);
const GLOBAL_LIMIT = positiveIntegerEnv('HTTP_REQUESTS_GLOBAL', 6000);
const sources = new Map();
let globalWindow = { count: 0, expiresAt: Date.now() + WINDOW_MS };

function take(entry, limit, now) {
  if (!entry || now >= entry.expiresAt) entry = { count: 0, expiresAt: now + WINDOW_MS };
  entry.count += 1;
  return { entry, allowed: entry.count <= limit };
}

function httpRateLimit(req, res, next) {
  const now = Date.now();
  ({ entry: globalWindow } = take(globalWindow, GLOBAL_LIMIT, now));
  if (globalWindow.count > GLOBAL_LIMIT) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Too many requests' });
  }

  const source = crypto.createHash('sha256')
    .update(normalizeSource(req.ip || req.socket?.remoteAddress || 'unknown'))
    .digest('hex');
  const result = take(sources.get(source), SOURCE_LIMIT, now);
  sources.set(source, result.entry);
  if (!result.allowed) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Too many requests' });
  }
  return next();
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [source, entry] of sources) {
    if (now >= entry.expiresAt) sources.delete(source);
  }
}, WINDOW_MS);
cleanupTimer.unref();

module.exports = { httpRateLimit };
