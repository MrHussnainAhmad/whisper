/**
 * matchmaking.js - Random Matchmaking & Room Management
 *
 * Queue and room state live only in this server process RAM. Room creation
 * and teardown do not yield, so claims are atomic within this one process.
 */

const crypto = require('crypto');
const {
  getSession,
  clearSessionRoom,
  claimSessionRooms,
} = require('./sessions');

// In-memory store
const waitingQueue = [];
const rooms = new Map();

/**
 * Add a user to the random matchmaking queue.
 * Returns a match object if two users are now waiting, otherwise null.
 */
const blockedPairs = new Map();
const pairKey = (a, b) => [a, b].sort().join(':');
function blockPair(a, b) { if (blockedPairs.size >= 10000) throw new Error('Block capacity reached'); blockedPairs.set(pairKey(a, b), Date.now() + 1800000); }
const blockCleanup = setInterval(() => { for (const [key, until] of blockedPairs) if (until <= Date.now()) blockedPairs.delete(key); }, 60000); blockCleanup.unref();
function forgetBlocks(id) { for (const key of blockedPairs.keys()) if (key.split(':').includes(id)) blockedPairs.delete(key); }
function joinQueue(sessionId, socketId, sourceKey = sessionId) {
  const now = Date.now();
  for (const [key, until] of blockedPairs) if (until <= now) blockedPairs.delete(key);
  const session = getSession(sessionId);
  if (!session || session.socketId !== socketId || session.roomId) return null;
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    const item = waitingQueue[i], live = getSession(item.sessionId);
    if (!live || live.roomId || live.socketId !== item.socketId || now - item.queuedAt >= 120000) waitingQueue.splice(i, 1);
  }
  if (waitingQueue.some(item => item.sessionId === sessionId)) return null;
  const index = waitingQueue.findIndex(item => item.sessionId !== sessionId && !blockedPairs.has(pairKey(item.sourceKey, sourceKey)));
  if (index < 0) { waitingQueue.push({ sessionId, socketId, sourceKey, queuedAt: now }); return null; }
  const user1 = waitingQueue.splice(index, 1)[0], user2 = { sessionId, socketId, sourceKey };
  const roomId = crypto.randomUUID();
  if (!setRoomIfSessionsAvailable(roomId, { session1: user1, session2: user2 })) return null;
  return { roomId, user1, user2 };
}

/**
 * Remove a user from the waiting queue (e.g. cancelled search).
 */
function leaveQueue(sessionId) {
  const index = waitingQueue.findIndex((w) => w.sessionId === sessionId);
  if (index !== -1) {
    waitingQueue.splice(index, 1);
    return true;
  }
  return false;
}

/**
 * Check if a session is currently waiting in the queue.
 */
function isInQueue(sessionId) {
  return waitingQueue.some((w) => w.sessionId === sessionId);
}

/**
 * Get a room by its ID.
 */
function getRoom(roomId) {
  return rooms.get(roomId);
}

/**
 * Find the room that contains a given session.
 * Returns { roomId, room } or null.
 */
function getRoomBySessionId(sessionId) {
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

/**
 * Get the peer's socket ID within a room.
 */
function getPeerSocketId(roomId, sessionId, knownRoom = null) {
  const room = knownRoom || getRoom(roomId);
  if (!room) return null;
  let peerSessionId = null;

  if (room.session1.sessionId === sessionId) {
    peerSessionId = room.session2.sessionId;
  } else if (room.session2.sessionId === sessionId) {
    peerSessionId = room.session1.sessionId;
  } else {
    return null;
  }

  const peerSession = getSession(peerSessionId);
  if (peerSession?.socketId && peerSession.roomId === roomId) return peerSession.socketId;
  return null;
}

/**
 * Destroy a room permanently.
 * Removes the room and clears both participants' room/key metadata.
 */
function destroyRoom(roomId) {
  const room = getRoom(roomId);
  if (!room) return null;

  rooms.delete(roomId);
  clearSessionRoom(room.session1.sessionId, roomId);
  clearSessionRoom(room.session2.sessionId, roomId);
  return room;
}

/**
 * Get counts for health check.
 */
function getQueueSize() {
  return waitingQueue.length;
}

function getRoomCount() {
  return rooms.size;
}

/**
 * Internal helper: directly set a room (used by invite system).
 */
function _setRoom(roomId, room) {
  return setRoomIfSessionsAvailable(roomId, room);
}

/** Consume an invite and claim its room without yielding to another event. */
function _setInviteRoom(roomId, room, locator, expectedInviterSessionId) {
  const { consumeInvite } = require('./invites');
  const claimed = consumeInvite(locator, expectedInviterSessionId);
  if (!claimed) return { created: false, inviteConsumed: false };
  const created = setRoomIfSessionsAvailable(roomId, room);
  if (!created) {
    const { _restoreInvite } = require('./invites');
    _restoreInvite(locator, claimed);
    return { created: false, inviteConsumed: false };
  }
  return { created: true, inviteConsumed: true };
}

function setRoomIfSessionsAvailable(roomId, room) {
  if (rooms.has(roomId)) return false;
  const first = getSession(room.session1.sessionId);
  const second = getSession(room.session2.sessionId);
  if (first?.socketId !== room.session1.socketId || second?.socketId !== room.session2.socketId) return false;
  const claimed = claimSessionRooms(room.session1.sessionId, room.session2.sessionId, roomId);
  if (!claimed) return false;
  rooms.set(roomId, room);
  return true;
}

module.exports = {
  blockPair, forgetBlocks, joinQueue,
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
