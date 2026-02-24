/**
 * handlers.js - Socket.IO Event Handlers
 *
 * ANONYMITY GUARANTEE:
 * - Messages are relayed in real-time and never stored.
 * - Images are forwarded as base64 payloads and never written to disk.
 * - If the receiver is offline, the message is silently dropped.
 * - No message logs, no analytics, no telemetry.
 */

const { v4: uuidv4 } = require('uuid');
const { addSession, removeSession, getSession } = require('./sessions');
const {
  joinQueue,
  leaveQueue,
  isInQueue,
  getRoomBySessionId,
  getPeerSocketId,
  destroyRoom,
} = require('./matchmaking');
const { createInvite, redeemInvite, cancelInvite, hasInvite } = require('./invites');
const { setSessionRoom } = require('./sessions');
const { isAllowed, clearLimit } = require('./rateLimiter');

// Max encrypted payload bytes (server cannot inspect message type due to E2E).
const MAX_ENCRYPTED_BYTES = 35 * 1024 * 1024; // ~35MB

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
  /**
   * JOIN - Client sends session ID on connect.
   * This registers the anonymous session in RAM.
   */
  socket.on('join', async (data) => {
    const { sessionId } = data || {};
    if (!sessionId || typeof sessionId !== 'string') {
      socket.emit('error', { message: 'Invalid session ID' });
      return;
    }

    const existing = await getSession(sessionId);
    if (existing && existing.socketId !== socket.id) {
      const prevSocket = io.sockets.sockets.get(existing.socketId);
      if (prevSocket) {
        // Prevent duplicate cleanup on old disconnect
        prevSocket.sessionId = null;
        prevSocket.disconnect(true);
      }
      await cleanupSessionState(io, sessionId);
    }

    await addSession(sessionId, socket.id);
    socket.sessionId = sessionId; // Attach for quick lookup
    socket.emit('joined', { status: 'ok' });
  });

  /**
   * FIND RANDOM - Enter the matchmaking queue.
   */
  socket.on('find-random', async () => {
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
  socket.on('cancel-search', async () => {
    const sessionId = socket.sessionId;
    if (!sessionId) return;
    await leaveQueue(sessionId);
    // If a match already happened, treat cancel as leaving the room
    await handleDisconnectFromRoom(io, socket);
  });

  /**
   * CREATE INVITE - Generate a one-time invite code.
   */
  socket.on('create-invite', async () => {
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
      socket.emit('error', { message: 'Cancel search before creating an invite' });
      return;
    }

    if (await hasInvite(sessionId)) {
      await cancelInvite(sessionId);
    }

    const code = await createInvite(sessionId, socket.id);
    socket.emit('invite-created', { code });
  });

  /**
   * JOIN INVITE - Redeem an invite code and start a chat.
   */
  socket.on('join-invite', async (data) => {
    const { code } = data || {};
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

    if (!code || typeof code !== 'string') {
      socket.emit('error', { message: 'Invalid invite code' });
      return;
    }

    const invite = await redeemInvite(code.toUpperCase().trim());
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

    await leaveQueue(invite.sessionId);
    await leaveQueue(sessionId);

    const roomId = uuidv4();
    await setSessionRoom(invite.sessionId, roomId);
    await setSessionRoom(sessionId, roomId);

    await _createInviteRoom(roomId, invite, sessionId, socket.id);

    io.to(invite.socketId).emit('matched', { roomId });
    io.to(socket.id).emit('matched', { roomId });
  });

  /**
   * KEY EXCHANGE - Relay public key to peer.
   */
  socket.on('key-exchange', async (data) => {
    const sessionId = socket.sessionId;
    if (!sessionId) return;

    const { publicKey } = data || {};
    if (!publicKey || typeof publicKey !== 'string') return;

    const roomData = await getRoomBySessionId(sessionId);
    if (!roomData) return;

    const peerSocketId = await getPeerSocketId(roomData.roomId, sessionId);
    if (!peerSocketId) return;

    io.to(peerSocketId).emit('peer-key', { publicKey });
  });

  /**
   * SEND ENCRYPTED - Relay an E2E encrypted message to the peer.
   */
  socket.on('send-encrypted', async (data) => {
    const sessionId = socket.sessionId;
    if (!sessionId) return;

    if (!(await isAllowed(sessionId))) {
      socket.emit('error', { message: 'Too many messages. Please slow down.' });
      return;
    }

    const { encrypted } = data || {};
    if (!encrypted || typeof encrypted !== 'string') return;

    if (estimateBase64Bytes(encrypted) > MAX_ENCRYPTED_BYTES) {
      socket.emit('error', { message: 'Payload too large.' });
      return;
    }

    const roomData = await getRoomBySessionId(sessionId);
    if (!roomData) return;

    const peerSocketId = await getPeerSocketId(roomData.roomId, sessionId);
    if (!peerSocketId) return;

    io.to(peerSocketId).emit('receive-encrypted', { encrypted });
  });

  /**
   * SECURITY ALERT - Notify peer of a capture attempt (screenshot/recording).
   */
  socket.on('security-alert', async (data) => {
    const sessionId = socket.sessionId;
    if (!sessionId) return;

    const roomData = await getRoomBySessionId(sessionId);
    if (!roomData) return;

    const peerSocketId = await getPeerSocketId(roomData.roomId, sessionId);
    if (!peerSocketId) return;

    io.to(peerSocketId).emit('peer-security-alert', data);
  });

  /**
   * CHAT READY - Signal that the user has entered the Chat Screen.
   */
  socket.on('chat-ready', async () => {
    const sessionId = socket.sessionId;
    if (!sessionId) return;
    const roomData = await getRoomBySessionId(sessionId);
    if (!roomData) return;
    const peerSocketId = await getPeerSocketId(roomData.roomId, sessionId);
    if (peerSocketId) io.to(peerSocketId).emit('peer-ready');
  });

  /**
   * REPORT - Report a user. Both users are disconnected and the room is destroyed.
   */
  socket.on('report', async () => {
    const sessionId = socket.sessionId;
    if (!sessionId) return;

    const roomData = await getRoomBySessionId(sessionId);
    if (!roomData) return;

    const { roomId, room } = roomData;

    io.to(room.session1.socketId).emit('chat-ended', {
      reason: 'Chat ended due to a report.',
    });
    io.to(room.session2.socketId).emit('chat-ended', {
      reason: 'Chat ended due to a report.',
    });

    await destroyRoom(roomId);
  });

  /**
   * LEAVE ROOM - Voluntarily end the chat.
   */
  socket.on('leave-room', async () => {
    await handleDisconnectFromRoom(io, socket);
  });

  /**
   * DISCONNECT - Socket disconnected (app closed, network lost, etc.).
   */
  socket.on('disconnect', async () => {
    const sessionId = socket.sessionId;
    if (!sessionId) return;

    await leaveQueue(sessionId);
    await cancelInvite(sessionId);
    await handleDisconnectFromRoom(io, socket);
    await clearLimit(sessionId);
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
      reason: 'The other person has left.',
    });
  }

  await destroyRoom(roomId);
}

/**
 * Cleanup all in-memory state for a session ID.
 * Used when session IDs collide or expire.
 */
async function cleanupSessionState(io, sessionId) {
  if (!sessionId) return;
  await leaveQueue(sessionId);
  await cancelInvite(sessionId);
  await handleDisconnectFromRoom(io, { sessionId });
  await clearLimit(sessionId);
  await removeSession(sessionId);
}

/**
 * Helper to create a room from an invite match.
 */
async function _createInviteRoom(roomId, invite, joinerId, joinerSocketId) {
  const matchmaking = require('./matchmaking');
  const room = {
    session1: { sessionId: invite.sessionId, socketId: invite.socketId },
    session2: { sessionId: joinerId, socketId: joinerSocketId },
  };
  await matchmaking._setRoom(roomId, room);
}

module.exports = { registerHandlers };
