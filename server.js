/**
 * server.js - Anonymous Chat Backend
 *
 * ANONYMITY GUARANTEE:
 * - This server stores nothing on disk.
 * - All state lives in RAM (process or Redis) and is destroyed on stop.
 * - No request logging of user data or messages.
 */

require('dotenv').config();

const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { app, ALLOWED_ORIGINS } = require('./app');
const { registerHandlers } = require('./handlers');
const { requireSecureSocket, ENFORCE_HTTPS } = require('./security');
const { addSession, removeSession, setExpireHandler } = require('./sessions');
const { acquireConnection, refreshConnections, releaseConnection } = require('./abuseLimiter');
const {
  leaveQueue,
  getRoomBySessionId,
  getPeerSocketId,
  destroyRoom,
} = require('./matchmaking');
const { cancelInvite } = require('./invites');
const { REDIS_URL, getRedisAdapterClients, verifyEphemeralRedisConfiguration } = require('./redisClient');

const PORT = process.env.PORT || 3000;

// --- HTTP Server ---
const server = http.createServer(app);
server.headersTimeout = 15_000;
server.requestTimeout = 20_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

// --- Socket.IO Setup ---
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS, // CORS_ORIGIN; * allowed for mobile clients
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 6 * 1024 * 1024,
  pingTimeout: 30000,
  pingInterval: 25000,
});

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
    console.error('Connection admission failed:', err?.message || err);
    return next(new Error('Connection rejected'));
  }
});

/**
 * On each new WebSocket connection, register all event handlers.
 */
io.on('connection', async (socket) => {
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

let leaseRefreshRunning = false;
const connectionLeaseTimer = setInterval(() => {
  if (leaseRefreshRunning) return;
  leaseRefreshRunning = true;
  refreshConnections(io.sockets.sockets.values())
    .catch((err) => console.error('Connection lease refresh failed:', err?.message || err))
    .finally(() => { leaseRefreshRunning = false; });
}, 30_000);
connectionLeaseTimer.unref();

async function start() {
  if (process.env.NODE_ENV === 'production' && !REDIS_URL) {
    throw new Error('REDIS_URL is required in production for atomic invites, shared sessions, and rate limits');
  }

  if (REDIS_URL) {
    await verifyEphemeralRedisConfiguration();
    let createAdapter;
    try {
      ({ createAdapter } = require('@socket.io/redis-adapter'));
    } catch (err) {
      throw new Error('Missing @socket.io/redis-adapter. Run `npm install` in backend.');
    }
    const clients = await getRedisAdapterClients();
    if (!clients) throw new Error('Redis adapter clients not available');
    io.adapter(createAdapter(clients.pubClient, clients.subClient));
    console.log('Socket.IO Redis adapter enabled.');
  }

  server.listen(PORT, () => {
    console.log(`Anonymous Chat Backend running on port ${PORT}`);
    console.log(REDIS_URL
      ? 'Privacy mode: Redis persistence is verified in production.'
      : 'Privacy mode: ephemeral process memory only (dev).');
    if (ENFORCE_HTTPS) {
      console.log('HTTPS enforcement: ON');
    }
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err?.message || err);
  process.exit(1);
});

/**
 * Graceful shutdown
 */
function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  io.close(() => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
