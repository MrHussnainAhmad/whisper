/**
 * matchmaking.js - Random Matchmaking & Room Management
 *
 * ANONYMITY GUARANTEE:
 * - Matchmaking queue and rooms live only in memory (process RAM or Redis RAM).
 * - No persistence to disk.
 * - When either user disconnects, the room is destroyed permanently.
 */

const { v4: uuidv4 } = require('uuid');
const { REDIS_URL, getRedisClient } = require('./redisClient');
const { getSession, setSessionRoom, clearSessionRoom } = require('./sessions');

const USE_REDIS = !!REDIS_URL;

// In-memory store
const waitingQueue = [];
const rooms = new Map();

const KEYS = {
  queueList: 'queue:list',
  queueSet: 'queue:set',
  room: (id) => `room:${id}`,
  roomSet: 'rooms:set',
  roomBySession: (sid) => `roomBySession:${sid}`,
};

/**
 * Add a user to the random matchmaking queue.
 * Returns a match object if two users are now waiting, otherwise null.
 */
async function joinQueue(sessionId, socketId) {
  if (!USE_REDIS) {
    const alreadyInQueue = waitingQueue.some((w) => w.sessionId === sessionId);
    if (alreadyInQueue) return null;

    waitingQueue.push({ sessionId, socketId });

    const popValid = async () => {
      while (waitingQueue.length) {
        const entry = waitingQueue.shift();
        const session = await getSession(entry.sessionId);
        if (session && session.socketId === entry.socketId && !session.roomId) {
          return entry;
        }
      }
      return null;
    };

    const user1 = await popValid();
    const user2 = await popValid();

    if (user1 && user2) {
      const roomId = uuidv4();
      const room = { session1: user1, session2: user2 };
      rooms.set(roomId, room);

      await setSessionRoom(user1.sessionId, roomId);
      await setSessionRoom(user2.sessionId, roomId);

      return { roomId, user1, user2 };
    }

    if (user1 && !user2) {
      waitingQueue.unshift(user1);
    }

    return null;
  }

  const client = await getRedisClient();
  const alreadyInQueue = await client.sIsMember(KEYS.queueSet, sessionId);
  if (alreadyInQueue) return null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const otherId = await client.rPop(KEYS.queueList);
    if (!otherId) {
      await client.lPush(KEYS.queueList, sessionId);
      await client.sAdd(KEYS.queueSet, sessionId);
      return null;
    }

    await client.sRem(KEYS.queueSet, otherId);
    if (otherId === sessionId) continue;

    const otherSession = await getSession(otherId);
    if (!otherSession || otherSession.roomId || !otherSession.socketId) continue;

    const roomId = uuidv4();
    const user1 = { sessionId, socketId };
    const user2 = { sessionId: otherId, socketId: otherSession.socketId };
    const room = { session1: user1, session2: user2 };

    await setRoom(roomId, room);
    await setSessionRoom(sessionId, roomId);
    await setSessionRoom(otherId, roomId);

    return { roomId, user1, user2 };
  }

  await client.lPush(KEYS.queueList, sessionId);
  await client.sAdd(KEYS.queueSet, sessionId);
  return null;
}

/**
 * Remove a user from the waiting queue (e.g. cancelled search).
 */
async function leaveQueue(sessionId) {
  if (!USE_REDIS) {
    const index = waitingQueue.findIndex((w) => w.sessionId === sessionId);
    if (index !== -1) {
      waitingQueue.splice(index, 1);
      return true;
    }
    return false;
  }

  const client = await getRedisClient();
  const removed = await client.sRem(KEYS.queueSet, sessionId);
  await client.lRem(KEYS.queueList, 0, sessionId);
  return removed > 0;
}

/**
 * Check if a session is currently waiting in the queue.
 */
async function isInQueue(sessionId) {
  if (!USE_REDIS) {
    return waitingQueue.some((w) => w.sessionId === sessionId);
  }
  const client = await getRedisClient();
  return (await client.sIsMember(KEYS.queueSet, sessionId)) === true;
}

/**
 * Get a room by its ID.
 */
async function getRoom(roomId) {
  if (!USE_REDIS) {
    return rooms.get(roomId);
  }
  const client = await getRedisClient();
  const raw = await client.get(KEYS.room(roomId));
  return raw ? JSON.parse(raw) : null;
}

/**
 * Find the room that contains a given session.
 * Returns { roomId, room } or null.
 */
async function getRoomBySessionId(sessionId) {
  if (!USE_REDIS) {
    for (const [roomId, room] of rooms) {
      if (
        room.session1.sessionId === sessionId ||
        room.session2.sessionId === sessionId
      ) {
        return { roomId, room };
      }
    }
    return null;
  }

  const client = await getRedisClient();
  const roomId = await client.get(KEYS.roomBySession(sessionId));
  if (!roomId) return null;
  const room = await getRoom(roomId);
  if (!room) return null;
  return { roomId, room };
}

/**
 * Get the peer's socket ID within a room.
 */
async function getPeerSocketId(roomId, sessionId) {
  const room = await getRoom(roomId);
  if (!room) return null;
  let peerSessionId = null;
  let fallbackSocketId = null;

  if (room.session1.sessionId === sessionId) {
    peerSessionId = room.session2.sessionId;
    fallbackSocketId = room.session2.socketId;
  } else if (room.session2.sessionId === sessionId) {
    peerSessionId = room.session1.sessionId;
    fallbackSocketId = room.session1.socketId;
  } else {
    return null;
  }

  const peerSession = await getSession(peerSessionId);
  if (peerSession?.socketId) return peerSession.socketId;
  return fallbackSocketId;
}

/**
 * Destroy a room permanently.
 * After this call, no trace of the room or its participants exists.
 */
async function destroyRoom(roomId) {
  const room = await getRoom(roomId);
  if (!room) return null;

  await clearSessionRoom(room.session1.sessionId);
  await clearSessionRoom(room.session2.sessionId);

  if (!USE_REDIS) {
    rooms.delete(roomId);
    return room;
  }

  const client = await getRedisClient();
  const multi = client.multi();
  multi.del(KEYS.room(roomId));
  multi.sRem(KEYS.roomSet, roomId);
  multi.del(KEYS.roomBySession(room.session1.sessionId));
  multi.del(KEYS.roomBySession(room.session2.sessionId));
  await multi.exec();
  return room;
}

/**
 * Get counts for health check.
 */
async function getQueueSize() {
  if (!USE_REDIS) return waitingQueue.length;
  const client = await getRedisClient();
  return await client.lLen(KEYS.queueList);
}

async function getRoomCount() {
  if (!USE_REDIS) return rooms.size;
  const client = await getRedisClient();
  return await client.sCard(KEYS.roomSet);
}

/**
 * Internal helper: directly set a room (used by invite system).
 */
async function _setRoom(roomId, room) {
  await setRoom(roomId, room);
  await setSessionRoom(room.session1.sessionId, roomId);
  await setSessionRoom(room.session2.sessionId, roomId);
}

async function setRoom(roomId, room) {
  if (!USE_REDIS) {
    rooms.set(roomId, room);
    return;
  }

  const client = await getRedisClient();
  const multi = client.multi();
  multi.set(KEYS.room(roomId), JSON.stringify(room));
  multi.sAdd(KEYS.roomSet, roomId);
  multi.set(KEYS.roomBySession(room.session1.sessionId), roomId);
  multi.set(KEYS.roomBySession(room.session2.sessionId), roomId);
  await multi.exec();
}

module.exports = {
  joinQueue,
  leaveQueue,
  isInQueue,
  getRoom,
  getRoomBySessionId,
  getPeerSocketId,
  destroyRoom,
  getQueueSize,
  getRoomCount,
  _setRoom,
};
