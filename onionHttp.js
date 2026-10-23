const http = require('node:http');
const { getOnionSource, isOnionRequest } = require('./torProxy');
const { securityHeaders } = require('./security');

function createOnionHttp(io) {
  // This HTTP server never listens directly. Only the PROXY gate emits sockets.
  const sources = new Map();
  let global = { until: 0, used: 0 };
  let cleanupTimer;
  const server = http.createServer();
  server.headersTimeout = 15000;
  server.requestTimeout = 20000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  function gate(req, res, next) {
    if (!isOnionRequest(req)) { req.socket.destroy(); return; }
    // Ignore all forwarding metadata, even if public proxy trust is configured.
    for (const name of Object.keys(req.headers)) {
      if (name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-')) delete req.headers[name];
    }
    if (req.headers.origin !== undefined) { req.socket.destroy(); return; }
    securityHeaders(req, res, () => {});
    if (req._query?.sid && io.engine.clients[req._query.sid]) { next(); return; }
    const now = Date.now();
    if (now >= global.until) {
      global = { until: now + 60000, used: 0 }; sources.clear();
      clearTimeout(cleanupTimer);
      cleanupTimer = setTimeout(() => sources.clear(), 60000); cleanupTimer.unref();
    }
    const key = getOnionSource(req);
    const count = sources.get(key) || 0;
    if (count >= 120 || global.used >= 6000) {
      res.writeHead(429, { 'Retry-After': '60' }); res.end(); return;
    }
    sources.set(key, count + 1); global.used++;
    next();
  }
  server.on('request', (req, res) => {
    if (req.url.startsWith('/socket.io/')) { io.engine.handleRequest(req, res); return; }
    gate(req, res, () => {
      const ok = req.method === 'GET' && ['/', '/health'].includes(req.url);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { status: 'ok' } : { error: 'Not found' }));
    });
  });
  server.on('upgrade', (req, socket, head) => {
    // Engine middleware handles header stripping/security and circuit binding.
    if (!isOnionRequest(req) || !req.url.startsWith('/socket.io/')) { socket.destroy(); return; }
    io.engine.handleUpgrade(req, socket, head);
  });
  server.on('close', () => { clearTimeout(cleanupTimer); sources.clear(); });
  server.on('clientError', (_error, socket) => socket.destroy());
  return { server, gate };
}
module.exports = { createOnionHttp };
