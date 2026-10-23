/**
 * server.js - Anonymous Chat Backend
 *
 * One-to-one payloads are forwarded as ciphertext without message history.
 * Session and routing metadata live only in this server process RAM.
 * Deployment logging, persistence, and network privacy require configuration;
 * see SECURITY_IMPLEMENTATION_PLAN.md for remaining work and limitations.
 */

require('dotenv').config();

const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { app, CORS_ORIGIN, ORIGIN_POLICY } = require('./app');
const { registerHandlers } = require('./handlers');
const { requireSecureSocket, ENFORCE_HTTPS } = require('./security');
const { requireHttps, securityHeaders } = require('./security');
const { httpRateLimit } = require('./httpLimiter');
const { createTransportAdmission } = require('./transportAdmission');
const { addSession, removeSession, setExpireHandler } = require('./sessions');
const { acquireConnection, releaseConnection } = require('./abuseLimiter');
const {
  startSecurityMonitoring,
  stopSecurityMonitoring,
  recordSecurityEvent,
} = require('./securityMonitor');
const {
  leaveQueue,
  getRoomBySessionId,
  getPeerSocketId,
  destroyRoom,
} = require('./matchmaking');
const { cancelInvite } = require('./invites');

const { isOnionRequest, getOnionSource } = require('./torProxy');
const { onionConfig, createOnionBoundary, listenOnion } = require('./onionListener');
const { createOnionHttp } = require('./onionHttp');
const onionSettings = onionConfig();

const PORT = process.env.PORT || 3000;
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const LISTEN_BACKLOG = (() => {
  const value = Number(process.env.LISTEN_BACKLOG || 2048);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('LISTEN_BACKLOG must be a positive integer');
  return value;
})();

// --- HTTP Server ---
const server = http.createServer(app);
server.headersTimeout = 15_000;
server.requestTimeout = 20_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

// --- Socket.IO Setup ---
const transportAdmission = createTransportAdmission(ORIGIN_POLICY);
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: false,
    maxAge: 600,
  },
  allowRequest: transportAdmission.allowRequest,
  maxHttpBufferSize: 288 * 1024,
  pingTimeout: 30000,
  pingInterval: 25000,
  connectTimeout: 10_000,
  // Ciphertext does not compress; deflate would only burn CPU and per-socket RAM.
  perMessageDeflate: false,
  httpCompression: false,
});

const onionHttp = createOnionHttp(io);
let onionBoundary;
// Pin every polling/upgrade request to its original transport class and circuit.
// A circuit change starts a new anonymous session; this is not resumption.
io.engine.use((req, res, next) => {
  const original = req._query?.sid && io.engine.clients[req._query.sid]?.request;
  if (original && (isOnionRequest(original) !== isOnionRequest(req) ||
      getOnionSource(original) !== getOnionSource(req))) {
    return next(new Error('Transport changed'));
  }
  if (isOnionRequest(req)) return onionHttp.gate(req, res, next);
  next();
});

// Engine.IO bypasses Express routes. Apply transport checks to polling and
// WebSocket upgrade requests as well as the initial handshake.
io.engine.use(requireHttps);
io.engine.use(securityHeaders);
io.engine.use((req, res, next) => isOnionRequest(req) || req._query?.sid ? next() : httpRateLimit(req, res, next));
io.engine.on('connection', transportAdmission.onConnection);

/**
 * Handle session expiration cleanup from sessions.js
 */
async function handleExpiredSessions(expired) {
  for (const entry of expired) {
    const { sessionId, socketId, roomId } = entry;

    if (socketId) {
      const s = io.sockets.sockets.get(socketId);
      if (s) {
        s.sessionId = null;
        s.disconnect(true);
      }
    }

    require('./proofOfWork').proofOfWork?.forget(sessionId);
    await leaveQueue(sessionId);
    await cancelInvite(sessionId);

    let activeRoomId = roomId;
    if (!activeRoomId) {
      const roomData = await getRoomBySessionId(sessionId);
      activeRoomId = roomData ? roomData.roomId : null;
    }

    if (activeRoomId) {
      const peerSocketId = await getPeerSocketId(activeRoomId, sessionId);
      if (peerSocketId) {
        io.to(peerSocketId).emit('chat-ended', {
          reasonCode: 'session_expired',
        });
      }
      await destroyRoom(activeRoomId);
    }
  }
}

setExpireHandler(handleExpiredSessions);

io.use(requireSecureSocket);

io.use(async (socket, next) => {
  try {
    if (!(await acquireConnection(socket))) return next(new Error('Too many connections'));
    return next();
  } catch (err) {
    recordSecurityEvent('connection-admission-error');
    console.error('Connection admission failed:', err?.message || err);
    return next(new Error('Connection rejected'));
  }
});

/**
 * On each new WebSocket connection, register all event handlers.
 */
const LOG_CONNECTIONS = process.env.NODE_ENV !== 'production';

io.on('connection', async (socket) => {
  // Per-connection stdout writes are synchronous on many hosts; skip them in production.
  if (LOG_CONNECTIONS) console.log('Device connected');

  let released = false;
  socket.on('disconnect', () => {
    if (released) return;
    released = true;
    releaseConnection(socket).catch((err) => {
      console.error('Connection lease release failed:', err?.message || err);
    });
  });

  const sessionId = crypto.randomUUID();
  try {
    await addSession(sessionId, socket.id);
    if (!socket.connected) {
      await removeSession(sessionId);
      return;
    }
    socket.sessionId = sessionId;
    socket.chatVerified = false;
    registerHandlers(io, socket);
    socket.emit('joined', { status: 'ok' });
  } catch (err) {
    console.error('Session initialization failed:', err?.message || err);
    socket.disconnect(true);
  }
});

async function start() {
  if (onionSettings.enabled) {
    onionBoundary = createOnionBoundary(onionHttp.server, onionSettings);
    await listenOnion(onionBoundary, onionSettings);
  }
  startSecurityMonitoring();

  server.listen(PORT, BIND_HOST, LISTEN_BACKLOG, () => {
    console.log(`Anonymous Chat Backend running on port ${PORT}`);
    console.log('Privacy mode: temporary state in this process RAM only; no external state service.');
    if (ENFORCE_HTTPS) {
      console.log('HTTPS enforcement: ON');
    }
  });
}

if (require.main === module) start().catch((err) => {
  console.error('Failed to start server:', err?.message || err);
  process.exit(1);
});

/**
 * Graceful shutdown
 */
let shutdownStarted = false;

async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`Received ${signal}, shutting down...`);
  const forceExitTimer = setTimeout(() => process.exit(1), 5000);
  stopSecurityMonitoring();
  require('./proofOfWork').proofOfWork?.close();
  await onionBoundary?.close();
  await io.close();
  clearTimeout(forceExitTimer);
  process.exit(0);
}

process.on('SIGINT', () => { shutdown('SIGINT').catch((err) => {
  console.error('Shutdown failed:', err?.message || err);
  process.exit(1);
}); });
process.on('SIGTERM', () => { shutdown('SIGTERM').catch((err) => {
  console.error('Shutdown failed:', err?.message || err);
  process.exit(1);
}); });

module.exports = { start, server, io, onionHttp };
