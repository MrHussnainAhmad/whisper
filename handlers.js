/**
 * handlers.js - Socket.IO Event Handlers
 *
 * ANONYMITY GUARANTEE:
 * - Messages are relayed in real-time and never stored.
 * - Images are forwarded as base64 payloads and never written to disk.
 * - If the receiver is offline, the message is silently dropped.
 * - No message logs, no analytics, no telemetry.
 */

const crypto = require('crypto');
const {
  removeSession,
  getSession,
  setSessionPublicKey,
  clearSessionPublicKey,
} = require('./sessions');
const {
  joinQueue,
  leaveQueue,
  isInQueue,
  getRoomBySessionId,
  getPeerSocketId,
  destroyRoom,
} = require('./matchmaking');
const { createInvite, getInvite, consumeInvite, cancelInvite, hasInvite } = require('./invites');
const { isValidInviteLocator } = require('./inviteRateLimiter');
const { isValidPublicKey, isValidBase64 } = require('./validation');
const { allowAction } = require('./abuseLimiter');

// Max encrypted payload bytes (server cannot inspect message type due to E2E).
const MAX_ENCRYPTED_BYTES = 4 * 1024 * 1024;
const MAX_ENCRYPTED_BASE64_CHARS = Math.ceil(MAX_ENCRYPTED_BYTES / 3) * 4;

function estimateBase64Bytes(b64) {
  if (!b64) return 0;
  const len = b64.length;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Register all event handlers for a new socket connection.
 */
function registerHandlers(io, socket) {
  const on = (event, handler) => {
    socket.on(event, (...args) => {
      Promise.resolve()
        .then(() => handler(...args))
        .catch((err) => {
          console.error(`Socket event ${event} failed:`, err?.message || err);
          if (event !== 'disconnect' && socket.connected) {
            socket.emit('error', { message: 'Request failed' });
            const ack = args.at(-1);
            if (typeof ack === 'function') ack({ ok: false, error: 'Request failed' });
          }
        });
    });
  };
  const resetChatState = async () => {
    socket.chatVerified = false;
    socket.data.publicKey = null;
    if (socket.sessionId) await clearSessionPublicKey(socket.sessionId);
  };
  /**
   * FIND RANDOM - Enter the matchmaking queue.
   */
  on('find-random', async () => {
    const sessionId = socket.sessionId;
    const session = sessionId ? await getSession(sessionId) : null;
    if (!sessionId || !session) {
      socket.emit('error', { message: 'Session not found' });
      return;
    }

    if (session.roomId) {
      socket.emit('error', { message: 'You are already in a chat' });
      return;
    }

    if (!(await allowAction(socket, 'matchmaking', { limit: 10, sourceLimit: 20, globalLimit: 1000 }))) {
      socket.emit('error', { message: 'Too many requests. Please wait.' });
      return;
    }
    await resetChatState();

    if (await hasInvite(sessionId)) {
      await cancelInvite(sessionId);
    }

    const match = await joinQueue(sessionId, socket.id);

    if (match) {
      const { roomId, user1, user2 } = match;
      io.to(user1.socketId).emit('matched', { roomId });
      io.to(user2.socketId).emit('matched', { roomId });
    } else {
      socket.emit('waiting', { message: 'Looking for someone online...' });
    }
  });

  /**
   * CANCEL SEARCH - Leave the matchmaking queue.
   */
  on('cancel-search', async () => {
    const sessionId = socket.sessionId;
    if (!sessionId) return;
    await leaveQueue(sessionId);
    // If a match already happened, treat cancel as leaving the room
    await handleDisconnectFromRoom(io, socket);
  });

  /**
   * CREATE INVITE - Generate a one-time invite code.
   */
  on('create-invite', async (data, ack) => {
    const reply = (response) => { if (typeof ack === 'function') ack(response); };
    const sessionId = socket.sessionId;
    const session = sessionId ? await getSession(sessionId) : null;
    if (!sessionId || !session) {
      socket.emit('error', { message: 'Session not found' });
      reply({ ok: false, error: 'Session not found' });
      return;
    }

    if (session.roomId) {
      socket.emit('error', { message: 'You are already in a chat' });
      reply({ ok: false, error: 'You are already in a chat' });
      return;
    }

    if (await isInQueue(sessionId)) {
      socket.emit('error', { message: 'Cancel search before creating an invite' });
      reply({ ok: false, error: 'Cancel search before creating an invite' });
      return;
    }

    if (!(await allowAction(socket, 'invite-create', {
      limit: 5, sourceLimit: 10, globalLimit: 5000, windowMs: 300_000,
    }))) {
      socket.emit('error', { message: 'Too many invites. Please wait.' });
      reply({ ok: false, error: 'Too many invites. Please wait.' });
      return;
    }
    await resetChatState();

    if (await hasInvite(sessionId)) {
      await cancelInvite(sessionId);
    }

    const locator = await createInvite(sessionId, socket.id);
    reply({ ok: true, locator });
  });

  on('cancel-invite', async () => {
    if (socket.sessionId) await cancelInvite(socket.sessionId);
  });

  /**
   * JOIN INVITE - Redeem an invite code and start a chat.
   */
  on('join-invite', async (data) => {
    const locator = data?.locator?.toUpperCase().trim();
    const sessionId = socket.sessionId;

    const session = sessionId ? await getSession(sessionId) : null;
    if (!sessionId || !session) {
      socket.emit('error', { message: 'Session not found' });
      return;
    }

    if (session.roomId) {
      socket.emit('error', { message: 'You are already in a chat' });
      return;
    }

    if (await isInQueue(sessionId)) {
      socket.emit('error', { message: 'Cancel search before joining an invite' });
      return;
    }

    if (!locator || typeof locator !== 'string') {
      socket.emit('error', { message: 'Invite code not found or expired' });
      return;
    }

    if (!isValidInviteLocator(locator)) {
      socket.emit('error', { message: 'Invite code not found or expired' });
      return;
    }

    if (!(await allowAction(socket, 'invite-join', { limit: 5, sourceLimit: 10, globalLimit: 2000 }))) {
      socket.emit('error', { message: 'Too many attempts. Wait a minute and try again.' });
      return;
    }

    const invite = await getInvite(locator);
    if (!invite) {
      socket.emit('error', { message: 'Invite code not found or expired' });
      return;
    }

    const inviterSession = await getSession(invite.sessionId);
    if (!inviterSession || inviterSession.roomId) {
      socket.emit('error', { message: 'Invite code not found or expired' });
      return;
    }

    if (invite.sessionId === sessionId) {
      socket.emit('error', { message: 'Cannot join your own invite' });
      return;
    }

    await resetChatState();

    await leaveQueue(invite.sessionId);
    await leaveQueue(sessionId);

    const roomId = crypto.randomUUID();
    const roomResult = await _createInviteRoom(roomId, invite, sessionId, socket.id, locator);
    if (!roomResult.created) {
      socket.emit('error', { message: 'Invite is no longer available' });
      return;
    }

    const claimedInvite = roomResult.inviteConsumed
      ? invite
      : await consumeInvite(locator, invite.sessionId);
    if (!claimedInvite) {
      await destroyRoom(roomId);
      socket.emit('error', { message: 'Invite code not found or expired' });
      return;
    }

    io.to(claimedInvite.socketId).emit('matched', { roomId });
    io.to(socket.id).emit('matched', { roomId });
  });

  /**
   * KEY EXCHANGE - Relay public key to peer.
   */
  on('key-exchange', async (data) => {
    const sessionId = socket.sessionId;
    if (!sessionId) {
      socket.emit('error', { message: 'Session not found' });
      return;
    }

    const { publicKey } = data || {};
    if (!isValidPublicKey(publicKey)) {
      socket.emit('error', { message: 'Invalid key exchange payload.' });
      return;
    }

    if (!(await allowAction(socket, 'key-exchange', { limit: 4, sourceLimit: 12 }))) {
      socket.emit('rate-limited', { action: 'key-exchange', retryAfterMs: 60_000 });
      return;
    }

    if (socket.data.publicKey && socket.data.publicKey !== publicKey) {
      socket.emit('error', { message: 'Security key changed during this chat.' });
      return;
    }
    if (!socket.data.publicKey) {
      socket.data.publicKey = publicKey;
      socket.chatVerified = false;
      await setSessionPublicKey(sessionId, publicKey);
    }

    const roomData = await getRoomBySessionId(sessionId);
    if (!roomData) {
      socket.emit('error', { message: 'Not in a chat' });
      return;
    }

    const peerSocketId = await getPeerSocketId(roomData.roomId, sessionId);
    if (!peerSocketId) {
      socket.emit('error', { message: 'Peer is unavailable' });
      return;
    }

    io.to(peerSocketId).emit('peer-key', { publicKey });
  });

  /**
   * SEND ENCRYPTED - Relay an E2E encrypted message to the peer.
   */
  on('send-encrypted', async (data) => {
    const sessionId = socket.sessionId;
    if (!sessionId) {
      socket.emit('error', { message: 'Session not found' });
      return;
    }

    if (!(await allowAction(socket, 'message-count', { limit: 30, sourceLimit: 60, globalLimit: 6000 }))) {
      socket.emit('error', { message: 'Too many messages. Please slow down.' });
      return;
    }

    const { encrypted } = data || {};
    if (!isValidBase64(encrypted, MAX_ENCRYPTED_BASE64_CHARS)) {
      socket.emit('error', { message: 'Invalid encrypted payload.' });
      return;
    }

    const encryptedBytes = estimateBase64Bytes(encrypted);
    if (encryptedBytes > MAX_ENCRYPTED_BYTES) {
      socket.emit('error', { message: 'Payload too large.' });
      return;
    }

    if (!(await allowAction(socket, 'message-bytes', {
      limit: 8 * 1024 * 1024,
      sourceLimit: 16 * 1024 * 1024,
      globalLimit: 256 * 1024 * 1024,
      cost: Math.max(1, encryptedBytes),
    }))) {
      socket.emit('error', { message: 'Bandwidth limit reached. Please wait.' });
      return;
    }

    if (!socket.chatVerified) {
      socket.emit('error', { message: 'Verify chat security before sending.' });
      return;
    }

    const roomData = await getRoomBySessionId(sessionId);
    if (!roomData) {
      socket.emit('error', { message: 'Not in a chat' });
      return;
    }

    const peerSocketId = await getPeerSocketId(roomData.roomId, sessionId);
    if (!peerSocketId) {
      socket.emit('error', { message: 'Peer is unavailable' });
      return;
    }

    io.to(peerSocketId).emit('receive-encrypted', { encrypted });
  });

  /** Ephemeral typing metadata. It is validated, rate-limited, and never stored. */
  on('typing', async (data) => {
    const sessionId = socket.sessionId;
    if (!sessionId || !socket.chatVerified || typeof data?.active !== 'boolean') return;
    if (!(await allowAction(socket, 'typing', {
      limit: 40, sourceLimit: 80, globalLimit: 8000,
    }))) return;

    const roomData = await getRoomBySessionId(sessionId);
    if (!roomData) return;
    const peerSocketId = await getPeerSocketId(roomData.roomId, sessionId);
    if (peerSocketId) io.to(peerSocketId).emit('peer-typing', { active: data.active });
  });

  /**
   * SECURITY ALERT - Notify peer of a capture attempt (screenshot/recording).
   */
  on('security-alert', async (data) => {
    const sessionId = socket.sessionId;
    if (!sessionId) return;

    const type = data?.type;
    if (type !== 'screenshot' && type !== 'recording') return;
    if (!(await allowAction(socket, 'security-alert', { limit: 3, sourceLimit: 6 }))) {
      socket.emit('rate-limited', { action: 'security-alert', retryAfterMs: 60_000 });
      return;
    }

    const roomData = await getRoomBySessionId(sessionId);
    if (!roomData) return;

    const peerSocketId = await getPeerSocketId(roomData.roomId, sessionId);
    if (!peerSocketId) return;

    io.to(peerSocketId).emit('peer-security-alert', { type, source: 'peer-claim' });
  });

  on('verify-chat', async (ack) => {
    const reply = (response) => { if (typeof ack === 'function') ack(response); };
    const sessionId = socket.sessionId;
    const roomData = sessionId ? await getRoomBySessionId(sessionId) : null;
    if (!sessionId || !roomData) {
      reply({ ok: false, error: 'Not in a chat' });
      return;
    }
    if (!(await allowAction(socket, 'verify-chat', { limit: 2, sourceLimit: 6 }))) {
      reply({ ok: false, error: 'Rate limited' });
      return;
    }
    if (!socket.data.publicKey) {
      reply({ ok: false, error: 'Key exchange incomplete' });
      return;
    }

    const room = roomData.room;
    const peerId = room.session1.sessionId === sessionId
      ? room.session2.sessionId
      : room.session1.sessionId;
    const peerSession = await getSession(peerId);
    if (!peerSession?.publicKey) {
      reply({ ok: false, error: 'Peer key exchange incomplete' });
      return;
    }

    socket.chatVerified = true;
    reply({ ok: true });
  });

  /**
   * CHAT READY - Signal that the user has entered the Chat Screen.
   */
  on('chat-ready', async () => {
    const sessionId = socket.sessionId;
    if (!sessionId) return;
    if (!(await allowAction(socket, 'chat-ready', { limit: 10, sourceLimit: 20, globalLimit: 2000 }))) {
      socket.emit('rate-limited', { action: 'chat-ready', retryAfterMs: 60_000 });
      return;
    }
    const roomData = await getRoomBySessionId(sessionId);
    if (!roomData) return;
    const peerSocketId = await getPeerSocketId(roomData.roomId, sessionId);
    if (peerSocketId) io.to(peerSocketId).emit('peer-ready');
  });

  /**
   * REPORT - Report a user. Both users are disconnected and the room is destroyed.
   */
  on('report', async () => {
    const sessionId = socket.sessionId;
    if (!sessionId) {
      socket.emit('error', { message: 'Session not found' });
      return;
    }

    if (!(await allowAction(socket, 'report', { limit: 3, sourceLimit: 5, windowMs: 300_000 }))) {
      socket.emit('rate-limited', { action: 'report', retryAfterMs: 300_000 });
      socket.emit('error', { message: 'Too many reports. Please wait.' });
      return;
    }

    const roomData = await getRoomBySessionId(sessionId);
    if (!roomData) {
      socket.emit('error', { message: 'Not in a chat' });
      return;
    }

    const { roomId } = roomData;
    const peerSocketId = await getPeerSocketId(roomId, sessionId);
    socket.emit('chat-ended', { reasonCode: 'reported' });
    if (peerSocketId) io.to(peerSocketId).emit('chat-ended', { reasonCode: 'reported' });

    await destroyRoom(roomId);
  });

  /**
   * LEAVE ROOM - Voluntarily end the chat.
   */
  on('leave-room', async () => {
    await handleDisconnectFromRoom(io, socket);
  });

  /**
   * DISCONNECT - Socket disconnected (app closed, network lost, etc.).
   */
  on('disconnect', async () => {
    const sessionId = socket.sessionId;
    if (!sessionId) return;

    await leaveQueue(sessionId);
    await cancelInvite(sessionId);
    await handleDisconnectFromRoom(io, socket);
    await removeSession(sessionId);
  });
}

/**
 * Handle disconnect from an active room.
 * Notifies the peer and destroys the room.
 */
async function handleDisconnectFromRoom(io, socket) {
  const sessionId = socket.sessionId;
  if (!sessionId) return;

  const roomData = await getRoomBySessionId(sessionId);
  if (!roomData) return;

  const { roomId } = roomData;
  const peerSocketId = await getPeerSocketId(roomId, sessionId);

  if (peerSocketId) {
    io.to(peerSocketId).emit('chat-ended', {
      reasonCode: 'peer_left',
    });
  }

  await destroyRoom(roomId);
}

/**
 * Helper to create a room from an invite match.
 */
async function _createInviteRoom(roomId, invite, joinerId, joinerSocketId, locator) {
  const matchmaking = require('./matchmaking');
  const room = {
    session1: { sessionId: invite.sessionId, socketId: invite.socketId },
    session2: { sessionId: joinerId, socketId: joinerSocketId },
  };
  return matchmaking._setInviteRoom(roomId, room, locator, invite.sessionId);
}

module.exports = { registerHandlers };
