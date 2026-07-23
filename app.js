const express = require('express');
const cors = require('cors');
const { requireHttps, securityHeaders } = require('./security');
const { TRUST_PROXY_HOPS } = require('./networkConfig');
const { httpRateLimit } = require('./httpLimiter');
const { createOriginPolicy } = require('./corsPolicy');

const ORIGIN_POLICY = createOriginPolicy(process.env.CORS_ORIGIN, process.env.NODE_ENV);
const ALLOWED_ORIGINS = (origin, callback) => {
  callback(null, ORIGIN_POLICY.allows(origin));
};

const app = express();
app.disable('x-powered-by');

// Trust reverse proxy (nginx/Caddy) for X-Forwarded-Proto
app.set('trust proxy', TRUST_PROXY_HOPS);

app.use(requireHttps);
app.use(securityHeaders);
app.use(httpRateLimit);
app.use((req, res, next) => {
  if (ORIGIN_POLICY.allows(req.headers.origin)) return next();
  return res.status(403).json({ error: 'Origin not allowed' });
});
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

module.exports = { app, ALLOWED_ORIGINS, ORIGIN_POLICY };
