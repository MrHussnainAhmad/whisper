const express = require('express');
const cors = require('cors');
const { requireHttps, securityHeaders } = require('./security');
const { TRUST_PROXY_HOPS } = require('./networkConfig');
const { httpRateLimit } = require('./httpLimiter');

const ALLOWED_ORIGINS = (() => {
  const raw = process.env.CORS_ORIGIN;
  if (process.env.NODE_ENV === 'production' && (!raw || raw.trim() === '*')) {
    throw new Error('CORS_ORIGIN must be an explicit allow-list in production');
  }
  if (!raw) return '*';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env.NODE_ENV === 'production' && list.includes('*')) {
    throw new Error('CORS_ORIGIN cannot contain * in production');
  }
  return list.length ? list : '*';
})();

const app = express();
app.disable('x-powered-by');

// Trust reverse proxy (nginx/Caddy) for X-Forwarded-Proto
app.set('trust proxy', TRUST_PROXY_HOPS);

app.use(requireHttps);
app.use(securityHeaders);
app.use(httpRateLimit);
app.use(cors({ origin: ALLOWED_ORIGINS, methods: ['GET', 'OPTIONS'] }));

/** Minimal root — no admin, no debug text, no user data */
app.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

/** Liveness probe — same minimal payload, no session or room counts */
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = { app, ALLOWED_ORIGINS };
