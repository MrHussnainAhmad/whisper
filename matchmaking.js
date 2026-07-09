/**
 * matchmaking.js - Random Matchmaking & Room Management
 *
 * ANONYMITY GUARANTEE:
 * - Matchmaking queue and rooms live only in memory (process RAM or Redis RAM).
 * - No persistence to disk.
 * - When either user disconnects, the room is destroyed permanently.
 */

const crypto = require('crypto');
const { REDIS_URL, getRedisClient } = require('./redisClient');
const { parseEphemeralJson } = require('./ephemeralJson');
const {
  getSession,
  clearSessionRoom,
  claimSessionRooms,
  REDIS_KEY_TTL_MS,
} = require('./sessions');

const USE_REDIS = !!REDIS_URL;

// In-memory store
const waitingQueue = [];
const rooms = new Map();

const KEYS = {
  queueList: 'queue:list',
  queueSet: 'queue:set',
  room: (id) => `room:${id}`,
  roomSet: 'rooms:expiry',
  roomBySession: (sid) => `roomBySession:${sid}`,
};

async function enqueueRedisSession(client, sessionId) {
  return client.eval(
    `if redis.call('SADD', KEYS[1], ARGV[1]) == 1 then
       redis.call('LPUSH', KEYS[2], ARGV[1])
       redis.call('PEXPIRE', KEYS[1], ARGV[2])
       redis.call('PEXPIRE', KEYS[2], ARGV[2])
       return 1
     end
     return 0`,
    { keys: [KEYS.queueSet, KEYS.queueList], arguments: [sessionId, String(REDIS_KEY_TTL_MS)] }
  );
}

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
      const roomId = crypto.randomUUID();
      const room = { session1: user1, session2: user2 };
      if (await setRoomIfSessionsAvailable(roomId, room)) {
        return { roomId, user1, user2 };
      }

      for (const entry of [user1, user2]) {
        const candidate = await getSession(entry.sessionId);
        if (candidate && candidate.socketId === entry.socketId && !candidate.roomId) {
          waitingQueue.push(entry);
        }
      }
      return null;
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
      await enqueueRedisSession(client, sessionId);
      return null;
    }

    await client.sRem(KEYS.queueSet, otherId);
    if (otherId === sessionId) continue;

    const otherSession = await getSession(otherId);
    if (!otherSession || otherSession.roomId || !otherSession.socketId) continue;

    const roomId = crypto.randomUUID();
    const user1 = { sessionId, socketId };
    const user2 = { sessionId: otherId, socketId: otherSession.socketId };
    const room = { session1: user1, session2: user2 };

    if (await setRoomIfSessionsAvailable(roomId, room)) {
      return { roomId, user1, user2 };
    }

    const stillIdleOther = await getSession(otherId);
    if (stillIdleOther && !stillIdleOther.roomId && stillIdleOther.socketId) {
      await enqueueRedisSession(client, otherId);
    }

    const currentSession = await getSession(sessionId);
    if (!currentSession || currentSession.roomId) return null;
  }

  await enqueueRedisSession(client, sessionId);
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
  return parseEphemeralJson(raw);
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
  if (!room) {
    await client.del(KEYS.roomBySession(sessionId));
    return null;
  }
  return { roomId, room };
}

/**
 * Get the peer's socket ID within a room.
 */
async function getPeerSocketId(roomId, sessionId) {
  const room = await getRoom(roomId);
  if (!room) return null;
  let peerSessionId = null;

  if (room.session1.sessionId === sessionId) {
    peerSessionId = room.session2.sessionId;
  } else if (room.session2.sessionId === sessionId) {
    peerSessionId = room.session1.sessionId;
  } else {
    return null;
  }

  const peerSession = await getSession(peerSessionId);
  if (peerSession?.socketId && peerSession.roomId === roomId) return peerSession.socketId;
  return null;
}

/**
 * Destroy a room permanently.
 * After this call, no trace of the room or its participants exists.
 */
async function destroyRoom(roomId) {
  const room = await getRoom(roomId);
  if (!room) return null;

  if (!USE_REDIS) {
    await clearSessionRoom(room.session1.sessionId);
    await clearSessionRoom(room.session2.sessionId);
    rooms.delete(roomId);
    return room;
  }

  const client = await getRedisClient();
  await client.eval(
    `for i = 1, 2 do
       local raw = redis.call('GET', KEYS[i])
       if raw then
         local ok, session = pcall(cjson.decode, raw)
         if ok and session.roomId == ARGV[1] then
           session.roomId = cjson.null
           redis.call('SET', KEYS[i], cjson.encode(session), 'PX', ARGV[2])
         end
       end
       local mapped = redis.call('GET', KEYS[i + 2])
       if mapped == ARGV[1] then redis.call('DEL', KEYS[i + 2]) end
     end
     redis.call('DEL', KEYS[5])
     redis.call('ZREM', KEYS[6], ARGV[1])
     return 1`,
    {
      keys: [
        `sess:${room.session1.sessionId}`,
        `sess:${room.session2.sessionId}`,
        KEYS.roomBySession(room.session1.sessionId),
        KEYS.roomBySession(room.session2.sessionId),
        KEYS.room(roomId),
        KEYS.roomSet,
      ],
      arguments: [roomId, String(REDIS_KEY_TTL_MS)],
    }
  );
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
  await client.zRemRangeByScore(KEYS.roomSet, 0, Date.now());
  return await client.zCard(KEYS.roomSet);
}

/**
 * Internal helper: directly set a room (used by invite system).
 */
async function _setRoom(roomId, room) {
  return setRoomIfSessionsAvailable(roomId, room);
}

/** Atomically consume a Redis invite locator and create its room. */
async function _setInviteRoom(roomId, room, locator, expectedInviterSessionId) {
  if (!USE_REDIS) {
    const { consumeInvite } = require('./invites');
    const claimed = await consumeInvite(locator, expectedInviterSessionId);
    if (!claimed) return { created: false, inviteConsumed: false };
    const created = await setRoomIfSessionsAvailable(roomId, room);
    if (!created) {
      const { _restoreInvite } = require('./invites');
      await _restoreInvite(locator, claimed);
      return { created: false, inviteConsumed: false };
    }
    return { created: true, inviteConsumed: true };
  }

  const client = await getRedisClient();
  const expiresAt = Date.now() + REDIS_KEY_TTL_MS;
  const result = await client.eval(
    `local inviteRaw = redis.call('GET', KEYS[7])
     if not inviteRaw then return 0 end
     local inviteOk, invite = pcall(cjson.decode, inviteRaw)
     if not inviteOk then return 0 end
     if invite.sessionId ~= ARGV[5] then return 0 end
     local raw1 = redis.call('GET', KEYS[1])
     local raw2 = redis.call('GET', KEYS[2])
     if not raw1 or not raw2 then return 0 end
     local firstOk, first = pcall(cjson.decode, raw1)
     local secondOk, second = pcall(cjson.decode, raw2)
     if not firstOk or not secondOk then return 0 end
     if first.roomId ~= cjson.null or second.roomId ~= cjson.null then return 0 end
     first.roomId = ARGV[1]
     second.roomId = ARGV[1]
     redis.call('SET', KEYS[1], cjson.encode(first), 'PX', ARGV[3])
     redis.call('SET', KEYS[2], cjson.encode(second), 'PX', ARGV[3])
     redis.call('SET', KEYS[3], ARGV[2], 'PX', ARGV[3])
     redis.call('ZADD', KEYS[4], ARGV[4], ARGV[1])
     redis.call('PEXPIRE', KEYS[4], ARGV[3])
     redis.call('SET', KEYS[5], ARGV[1], 'PX', ARGV[3])
     redis.call('SET', KEYS[6], ARGV[1], 'PX', ARGV[3])
     redis.call('DEL', KEYS[7])
     redis.call('DEL', KEYS[8])
     return 1`,
    {
      keys: [
        `sess:${room.session1.sessionId}`,
        `sess:${room.session2.sessionId}`,
        KEYS.room(roomId),
        KEYS.roomSet,
        KEYS.roomBySession(room.session1.sessionId),
        KEYS.roomBySession(room.session2.sessionId),
        `invite:${locator}`,
        `inviteBySession:${expectedInviterSessionId}`,
      ],
      arguments: [
        roomId, JSON.stringify(room), String(REDIS_KEY_TTL_MS),
        String(expiresAt), expectedInviterSessionId,
      ],
    }
  );
  return { created: Number(result) === 1, inviteConsumed: Number(result) === 1 };
}

async function setRoomIfSessionsAvailable(roomId, room) {
  if (!USE_REDIS) {
    const claimed = await claimSessionRooms(room.session1.sessionId, room.session2.sessionId, roomId);
    if (!claimed) return false;
    rooms.set(roomId, room);
    return true;
  }

  const client = await getRedisClient();
  const created = await client.eval(
    `local raw1 = redis.call('GET', KEYS[1])
     local raw2 = redis.call('GET', KEYS[2])
     if not raw1 or not raw2 then return 0 end
     local firstOk, first = pcall(cjson.decode, raw1)
     local secondOk, second = pcall(cjson.decode, raw2)
     if not firstOk or not secondOk then return 0 end
     if first.roomId ~= cjson.null or second.roomId ~= cjson.null then return 0 end
     first.roomId = ARGV[1]
     second.roomId = ARGV[1]
     redis.call('SET', KEYS[1], cjson.encode(first), 'PX', ARGV[3])
     redis.call('SET', KEYS[2], cjson.encode(second), 'PX', ARGV[3])
     redis.call('SET', KEYS[3], ARGV[2], 'PX', ARGV[3])
     redis.call('ZADD', KEYS[4], ARGV[4], ARGV[1])
     redis.call('PEXPIRE', KEYS[4], ARGV[3])
     redis.call('SET', KEYS[5], ARGV[1], 'PX', ARGV[3])
     redis.call('SET', KEYS[6], ARGV[1], 'PX', ARGV[3])
     return 1`,
    {
      keys: [
        `sess:${room.session1.sessionId}`,
        `sess:${room.session2.sessionId}`,
        KEYS.room(roomId),
        KEYS.roomSet,
        KEYS.roomBySession(room.session1.sessionId),
        KEYS.roomBySession(room.session2.sessionId),
      ],
      arguments: [
        roomId,
        JSON.stringify(room),
        String(REDIS_KEY_TTL_MS),
        String(Date.now() + REDIS_KEY_TTL_MS),
      ],
    }
  );
  return Number(created) === 1;
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
  _setInviteRoom,
};
