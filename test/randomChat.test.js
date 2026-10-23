const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { io } = require('socket.io-client');
const { startServer } = require('./serverFixture.cjs');
const once = (s, event) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(event + ' timed out')), 3000); s.once(event, value => { clearTimeout(t); resolve(value); }); });
const ack = (s, e, data = {}) => s.timeout(3000).emitWithAck(e, data);
test('random queue pairs once, cancel/timeout work, block ends with the anonymous session and groups stay off', async () => {
 const server = await startServer({ MATCH_WAIT_MS: '250' }); const sockets = [];
 const connect = async () => { const s = io(server.url, { transports: ['websocket'], reconnection: false }); sockets.push(s); await once(s, 'joined'); return s; };
 try {
  const a = await connect(), b = await connect();
  const timed = once(a, 'search-timeout'); assert.equal((await ack(a, 'find-random')).status, 'waiting'); await timed;
  assert.equal((await ack(a, 'find-random')).status, 'waiting'); a.emit('cancel-search');
  assert.equal((await ack(a, 'create-invite')).ok, true); // Event ordering proves cancel has left the queue.
  await ack(a, 'find-random'); const matched = once(a, 'matched');
  const result = await ack(b, 'find-random'); assert.equal(result.status, 'matched'); assert.equal((await matched).roomId, result.roomId);
  assert.equal((await ack(a, 'find-random')).ok, false);
  const ended = once(b, 'chat-ended'); assert.equal((await ack(a, 'block-peer')).ok, true); await ended;
  a.disconnect(); b.disconnect();
  const c = await connect(), d = await connect();
  assert.equal((await ack(c, 'find-random')).status, 'waiting');
  assert.equal((await ack(d, 'find-random')).status, 'matched'); // Fresh anonymous sessions are independent.
 } finally { for (const s of sockets) s.disconnect(); server.stop(); }
});
test('queue cannot match a session with itself and deletes room records on end', () => {
 const { addSession, removeSession } = require('../sessions'); const mm = require('../matchmaking');
 addSession('one', 's1'); addSession('two', 's2');
 assert.equal(mm.joinQueue('one', 's1'), null); assert.equal(mm.joinQueue('one', 's1'), null); assert.equal(mm.getQueueSize(), 1);
 const result = mm.joinQueue('two', 's2'); assert.ok(result); assert.equal(mm.getQueueSize(), 0);
 assert.equal(mm.joinQueue('one', 's1'), null); mm.destroyRoom(result.roomId); assert.equal(mm.getRoom(result.roomId), undefined);
 removeSession('one'); removeSession('two');
});

test('private code creation and formatted joining work with the obsolete flag false', async () => {
 const server = await startServer({ ALLOW_UNVERIFIED_CHATS: 'false' });
 const sockets = [];
 try {
  const connect = async () => {
   const socket = io(server.url, { transports: ['websocket'], reconnection: false });
   sockets.push(socket); await once(socket, 'joined'); return socket;
  };
  const creator = await connect(), joiner = await connect();
  const invite = await ack(creator, 'create-invite');
  assert.equal(invite.ok, true);
  assert.match(invite.locator, /^[0-9A-Z]{8}$/);
  const shortCode = once(joiner, 'error');
  joiner.emit('join-invite', { locator: invite.locator.slice(0, 6) });
  assert.match((await shortCode).message, /not found or expired/);
  const createdMatch = once(creator, 'matched'), joinedMatch = once(joiner, 'matched');
  const formatted = invite.locator.slice(0, 4) + '-' + invite.locator.slice(4);
  joiner.emit('join-invite', { locator: ' ' + formatted.toLowerCase() + ' ' });
  const [a, b] = await Promise.all([createdMatch, joinedMatch]);
  assert.ok(a.roomId); assert.equal(a.roomId, b.roomId);
 } finally { for (const socket of sockets) socket.disconnect(); server.stop(); }
});

test('leave-room clears chat state but keeps the connection session usable', async () => {
 const server = await startServer(); const sockets = [];
 const connect = async () => { const s = io(server.url, { transports: ['websocket'], reconnection: false }); sockets.push(s); await once(s, 'joined'); return s; };
 const keyBundle = Buffer.concat([Buffer.from([7]), Buffer.alloc(128, 9)]).toString('base64');
 try {
  const a = await connect(), b = await connect(), c = await connect();
  const invite = await ack(a, 'create-invite');
  const matches = [once(a, 'matched'), once(b, 'matched')];
  b.emit('join-invite', { locator: invite.locator });
  await Promise.all(matches);
  assert.equal((await ack(a, 'key-exchange', { keyBundle, protocolVersion: 7 })).ok, true);
  const peerEnded = once(b, 'chat-ended');
  assert.deepEqual(await ack(a, 'leave-room'), { ok: true });
  assert.equal((await peerEnded).reasonCode, 'peer_left');
  assert.equal((await ack(a, 'key-confirm', { proof: 'AAAA' })).error, 'Key exchange incomplete');
  assert.equal((await ack(b, 'send-encrypted', { encrypted: 'AAAA', messageId: crypto.randomUUID() })).ok, false);
  // Leaving while queued must withdraw the queue entry.
  assert.equal((await ack(a, 'find-random')).status, 'waiting');
  assert.deepEqual(await ack(a, 'leave-room'), { ok: true });
  assert.equal((await ack(c, 'find-random')).status, 'waiting');
  c.emit('cancel-search');
  assert.equal((await ack(c, 'create-invite')).ok, true); // Same-socket ordering proves c left the queue.
  // Both former participants keep live sessions and can start new chats.
  assert.equal((await ack(a, 'create-invite')).ok, true);
  assert.equal((await ack(b, 'find-random')).status, 'waiting');
 } finally { for (const s of sockets) s.disconnect(); server.stop(); }
});
