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

const QUEUE_ENTRY_TTL_MS = 120000;
const BLOCK_TTL_MS = 1800000;
const MAX_BLOCKED_PAIRS = (() => {
  const value = Number(process.env.MAX_BLOCKED_PAIRS || 50000);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('MAX_BLOCKED_PAIRS must be a positive integer');
  return value;
})();

// In-memory store. Map preserves insertion order, so iteration is FIFO.
const waitingQueue = new Map();
const rooms = new Map();
const sessionRooms = new Map();
let establishedRooms = 0;

const blockedPairs = new Map();
const blocksById = new Map();
const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

function indexBlock(id, key) {
  let keys = blocksById.get(id);
  if (!keys) { keys = new Set(); blocksById.set(id, keys); }
  keys.add(key);
}

function deleteBlock(key) {
  const entry = blockedPairs.get(key);
  if (!entry) return;
  blockedPairs.delete(key);
  for (const id of [entry.a, entry.b]) {
    const keys = blocksById.get(id);
    keys?.delete(key);
    if (keys?.size === 0) blocksById.delete(id);
  }
}

function pruneBlocks(now = Date.now()) {
  for (const [key, entry] of blockedPairs) if (entry.until <= now) deleteBlock(key);
}

function blockPair(a, b) {
  const key = pairKey(a, b);
  deleteBlock(key);
  if (blockedPairs.size >= MAX_BLOCKED_PAIRS) pruneBlocks();
  // Entries share one TTL, so the oldest insertion is the next to expire.
  while (blockedPairs.size >= MAX_BLOCKED_PAIRS) deleteBlock(blockedPairs.keys().next().value);
  blockedPairs.set(key, { a, b, until: Date.now() + BLOCK_TTL_MS });
  indexBlock(a, key);
  indexBlock(b, key);
}

function isBlocked(a, b, now) {
  const key = pairKey(a, b);
  const entry = blockedPairs.get(key);
  if (!entry) return false;
  if (entry.until > now) return true;
  deleteBlock(key);
  return false;
}

function forgetBlocks(id) {
  const keys = blocksById.get(id);
  if (!keys) return;
  for (const key of [...keys]) deleteBlock(key);
}

function isQueueEntryLive(item, now) {
  const live = getSession(item.sessionId);
  return !!live && !live.roomId && live.socketId === item.socketId &&
    now - item.queuedAt < QUEUE_ENTRY_TTL_MS;
}

function pruneQueue(now = Date.now()) {
  for (const [sessionId, item] of waitingQueue) {
    if (!isQueueEntryLive(item, now)) waitingQueue.delete(sessionId);
  }
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  pruneBlocks(now);
  pruneQueue(now);
}, 60000);
cleanupTimer.unref();

/**
 * Add a user to the random matchmaking queue.
 * Returns a match object if two users are now waiting, otherwise null.
 */
function joinQueue(sessionId, socketId) {
  const now = Date.now();
  const session = getSession(sessionId);
  if (!session || session.socketId !== socketId || session.roomId) return null;
  const existing = waitingQueue.get(sessionId);
  if (existing && isQueueEntryLive(existing, now)) return null;
  waitingQueue.delete(sessionId);

  let user1 = null;
  for (const [waitingId, item] of waitingQueue) {
    if (!isQueueEntryLive(item, now)) { waitingQueue.delete(waitingId); continue; }
    if (isBlocked(item.sessionId, sessionId, now)) continue;
    user1 = item;
    break;
  }
  if (!user1) {
    waitingQueue.set(sessionId, { sessionId, socketId, queuedAt: now });
    return null;
  }
  waitingQueue.delete(user1.sessionId);
  const user2 = { sessionId, socketId };
  const roomId = crypto.randomUUID();
  if (!setRoomIfSessionsAvailable(roomId, { session1: user1, session2: user2 })) return null;
  return { roomId, user1, user2 };
}

/**
 * Remove a user from the waiting queue (e.g. cancelled search).
 */
function leaveQueue(sessionId) {
  return waitingQueue.delete(sessionId);
}

/**
 * Check if a session is currently waiting in the queue.
 */
function isInQueue(sessionId) {
  const item = waitingQueue.get(sessionId);
  if (!item) return false;
  if (isQueueEntryLive(item, Date.now())) return true;
  waitingQueue.delete(sessionId);
  return false;
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
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return null;
  const room = rooms.get(roomId);
  return room ? { roomId, room } : null;
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
  for (const cleanup of room.cleanupCallbacks || []) cleanup();
  room.cleanupCallbacks?.clear();
  if (room.secureChannelLocked) establishedRooms -= 1;
  for (const { sessionId } of [room.session1, room.session2]) {
    if (sessionRooms.get(sessionId) === roomId) sessionRooms.delete(sessionId);
  }
  clearSessionRoom(room.session1.sessionId, roomId);
  clearSessionRoom(room.session2.sessionId, roomId);
  for (const member of [room.session1, room.session2]) {
    if (getSession(member.sessionId)?.socketId === null) require('./sessions').removeSession(member.sessionId);
  }
  return room;
}

/**
 * Get counts for health check.
 */
function getQueueSize() {
  return waitingQueue.size;
}

function getRoomCount() {
  return rooms.size;
}

function lockRoomSecureChannel(roomId) {
  const room = rooms.get(roomId);
  if (!room) return false;
  if (!room.secureChannelLocked) {
    room.secureChannelLocked = true;
    establishedRooms += 1;
  }
  return true;
}

function getEstablishedRoomCount() {
  return establishedRooms;
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
  if (rooms.has(roomId) || isBlocked(room.session1.sessionId, room.session2.sessionId, Date.now())) return false;
  const first = getSession(room.session1.sessionId);
  const second = getSession(room.session2.sessionId);
  if (first?.socketId !== room.session1.socketId || second?.socketId !== room.session2.socketId) return false;
  const claimed = claimSessionRooms(room.session1.sessionId, room.session2.sessionId, roomId);
  if (!claimed) return false;
  rooms.set(roomId, room);
  sessionRooms.set(room.session1.sessionId, roomId);
  sessionRooms.set(room.session2.sessionId, roomId);
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
  getEstablishedRoomCount,
  lockRoomSecureChannel,
  _setRoom,
  _setInviteRoom,
};
