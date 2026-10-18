/**
 * security.js — Transport security helpers
 *
 * HTTP routes and Socket.IO handshakes must use TLS in production.
 * Behind nginx/Caddy, explicitly set TRUST_PROXY to the trusted hop count.
 */

// Production HTTPS enforcement cannot be disabled by environment flags.
const ENFORCE_HTTPS = process.env.NODE_ENV === 'production';
const { trustProxy } = require('./networkConfig');

function isSecureRequest(req) {
  if (req.secure || req.socket?.encrypted === true || req.connection?.encrypted === true) return true;
  if (!req.socket?.remoteAddress || !trustProxy(req.socket.remoteAddress, 0)) return false;
  const forwarded = req.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string') {
    const proto = forwarded.split(',')[0].trim().toLowerCase();
    if (proto === 'https') return true;
  }
  return false;
}

function requireHttps(req, res, next) {
  if (!ENFORCE_HTTPS || isSecureRequest(req)) {
    return next();
  }
  res.statusCode = 403;
  res.setHeader('Content-Type', 'application/json');
  return res.end(JSON.stringify({ error: 'HTTPS required' }));
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

function requireSecureSocket(socket, next) {
  if (!ENFORCE_HTTPS) return next();
  const req = socket.request;
  if (isSecureRequest(req)) return next();
  return next(new Error('HTTPS required'));
}

module.exports = {
  ENFORCE_HTTPS,
  isSecureRequest,
  requireHttps,
  securityHeaders,
  requireSecureSocket,
};
