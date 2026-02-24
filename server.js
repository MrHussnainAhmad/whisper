/**
 * server.js - Anonymous Chat Backend
 *
 * ANONYMITY GUARANTEE:
 * - This server stores nothing on disk.
 * - All state lives in RAM (process or Redis) and is destroyed on stop.
 * - No request logging of user data or messages.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { registerHandlers } = require('./handlers');
const { getSessionCount, setExpireHandler } = require('./sessions');
const {
  getQueueSize,
  getRoomCount,
  leaveQueue,
  getRoomBySessionId,
  getPeerSocketId,
  destroyRoom,
} = require('./matchmaking');
const { cancelInvite } = require('./invites');
const { clearLimit } = require('./rateLimiter');
const { REDIS_URL, getRedisAdapterClients } = require('./redisClient');

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (() => {
  const raw = process.env.CORS_ORIGIN;
  if (!raw) return '*';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : '*';
})();

// --- Express Setup ---
const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '10mb' }));

/**
 * Health check endpoint.
 * Returns only aggregate counts - no session IDs, no user data.
 */
app.get('/health', async (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    activeSessions: await getSessionCount(),
    waitingInQueue: await getQueueSize(),
    activeRooms: await getRoomCount(),
  });
});

// --- HTTP Server ---
const server = http.createServer(app);

// --- Socket.IO Setup ---
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS, // Set via CORS_ORIGIN in production
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 30 * 1024 * 1024, // 30MB max for media payloads
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
          reason: 'The other person has left.',
        });
      }
      await destroyRoom(activeRoomId);
    }

    await clearLimit(sessionId);
  }
}

setExpireHandler(handleExpiredSessions);

/**
 * On each new WebSocket connection, register all event handlers.
 */
io.on('connection', (socket) => {
  registerHandlers(io, socket);
});

async function start() {
  if (REDIS_URL) {
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
    console.log('Privacy mode: all data in RAM only. No persistence.');
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
