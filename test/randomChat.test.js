const test = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer } = require('./serverFixture.cjs');
const once = (s, event) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(event + ' timed out')), 3000); s.once(event, value => { clearTimeout(t); resolve(value); }); });
const ack = (s, e, data = {}) => s.timeout(3000).emitWithAck(e, data);
test('random queue pairs once, cancel/timeout work, block survives reconnect and groups stay off', async () => {
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
  assert.equal((await ack(d, 'find-random')).status, 'waiting'); // Same source hashes remain blocked.
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
