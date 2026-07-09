const express = require('express');
const cors = require('cors');
const { requireHttps, securityHeaders } = require('./security');
const { TRUST_PROXY_HOPS } = require('./networkConfig');
const { httpRateLimit } = require('./httpLimiter');

// Mobile clients are not browser-origin bound; * is allowed in production.
// Set CORS_ORIGIN to a comma-separated allow-list if you later add a web client.
const ALLOWED_ORIGINS = (() => {
  const raw = process.env.CORS_ORIGIN;
  if (!raw || raw.trim() === '*') return '*';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
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
