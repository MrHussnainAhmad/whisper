const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { io } = require('socket.io-client');
const { startServer } = require('./serverFixture.cjs');
const ack = (socket, event, data = {}) => ['secure-channel-ready', 'verify-chat'].includes(event)
  ? socket.timeout(3000).emitWithAck(event) : socket.timeout(3000).emitWithAck(event, data);
const once = (socket, event) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(event + ' timeout')); }, 3000);
  const handler = value => { clearTimeout(timer); resolve(value); };
  socket.once(event, handler);
});
const bundle = byte => Buffer.concat([Buffer.from([7]), Buffer.alloc(128, byte)]).toString('base64');

async function fixture(t, env = {}) {
  const server = await startServer(env); const sockets = [];
  t.after(() => { for (const s of sockets) s.disconnect(); server.stop(); });
  return async () => {
    const socket = io(server.url, { transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(socket); await once(socket, 'joined'); return socket;
  };
}
async function match(a, b) {
  await ack(a, 'find-random'); const matched = once(a, 'matched');
  assert.equal((await ack(b, 'find-random')).status, 'matched'); await matched;
}
async function secure(a, b) {
  assert.equal((await ack(a, 'key-exchange', { keyBundle: bundle(1), protocolVersion: 7 })).ok, true);
  assert.equal((await ack(b, 'key-exchange', { keyBundle: bundle(2), protocolVersion: 7 })).ok, true);
  for (const s of [a, b]) assert.equal((await ack(s, 'key-confirm', { proof: 'AAAA' })).ok, true);
  for (const s of [a, b]) assert.equal((await ack(s, 'secure-channel-ready')).ok, true);
}

test('confirmed channel rejects key/proof injection, preserves ciphertext and acknowledgments, tears down', async t => {
  const connect = await fixture(t); const a = await connect(), b = await connect(), outsider = await connect();
  assert.equal((await ack(outsider, 'key-exchange', { keyBundle: bundle(3), protocolVersion: 7 })).ok, false);
  await match(a, b); await secure(a, b);
  let peerKeys = 0, peerProofs = 0;
  b.on('peer-key', () => peerKeys++); b.on('peer-key-confirm', () => peerProofs++);
  for (const keyBundle of [bundle(1), bundle(4)]) {
    assert.equal((await ack(a, 'key-exchange', { keyBundle, protocolVersion: 7 })).ok, false);
  }
  assert.equal((await ack(a, 'key-confirm', { proof: 'AAAA' })).ok, false);
  assert.equal((await ack(a, 'secure-channel-ready')).ok, true);
  assert.equal((await ack(a, 'verify-chat')).ok, true);
  assert.equal(peerKeys, 0); assert.equal(peerProofs, 0);
  for (const encrypted of ['not base64!!', 'A'.repeat(262148)]) {
    assert.equal((await ack(a, 'send-encrypted', { encrypted, messageId: crypto.randomUUID() })).ok, false);
  }
  for (const size of [32, 192 * 1024]) {
    const payload = { encrypted: crypto.randomBytes(size).toString('base64'), messageId: crypto.randomUUID() };
    const received = once(b, 'receive-encrypted');
    assert.equal((await ack(a, 'send-encrypted', payload)).ok, true);
    assert.deepEqual(await received, payload);
    assert.equal((await ack(a, 'send-encrypted', payload)).duplicate, true);
  }
  const ended = once(b, 'chat-ended'); await ack(a, 'leave-room'); await ended;
  assert.equal((await ack(b, 'secure-channel-ready')).ok, false);
  assert.equal((await ack(b, 'key-exchange', { keyBundle: bundle(2), protocolVersion: 7 })).ok, false);
  assert.equal((await ack(b, 'send-encrypted', { encrypted: 'AAAA', messageId: crypto.randomUUID() })).ok, false);
});

test('report blocks only the peer session on a shared IP, including invite attempts', async t => {
  const connect = await fixture(t); const a = await connect(), b = await connect(), c = await connect();
  await match(a, b);
  assert.equal((await ack(a, 'report', { category: 'invalid' })).ok, false);
  const ended = once(b, 'chat-ended');
  assert.equal((await ack(a, 'report', { category: 'spam' })).ok, true); await ended;
  const invite = await ack(a, 'create-invite');
  const rejected = once(b, 'error'); b.emit('join-invite', { locator: invite.locator });
  assert.match((await rejected).message, /no longer available/);
  assert.equal((await ack(a, 'find-random')).status, 'waiting');
  assert.equal((await ack(b, 'find-random')).status, 'waiting');
  assert.equal((await ack(c, 'find-random')).status, 'matched');
});

test('multiple shared-IP rooms relay while unmatched clients exhaust admission event capacity', async t => {
  const connect = await fixture(t, { MAX_CONNECTIONS_GLOBAL: '50' });
  const a = await connect(), b = await connect(), c = await connect(), d = await connect();
  await match(a, b); await secure(a, b);
  // Admission budget is 20/s at this deliberately tiny deployment cap.
  await new Promise(resolve => setTimeout(resolve, 1100));
  await match(c, d); await secure(c, d);
  const attacker = await connect();
  const disconnected = once(attacker, 'disconnect');
  for (let i = 0; i < 100; i++) attacker.emit('unknown-event');
  await disconnected;
  for (const [sender, peer] of [[a, b], [c, d]]) {
    const received = once(peer, 'receive-encrypted');
    const payload = { encrypted: 'AAAA', messageId: crypto.randomUUID() };
    assert.equal((await ack(sender, 'send-encrypted', payload)).ok, true);
    assert.deepEqual(await received, payload);
  }
});

test('a high-volume sender cannot starve a concurrent invite conversation or disconnect it', async t => {
  const connect = await fixture(t, { MAX_CONNECTIONS_GLOBAL: '100' });
  const a = await connect(), b = await connect(), c = await connect(), d = await connect();
  await match(a, b); await secure(a, b);
  const invite = await ack(c, 'create-invite');
  const matches = [once(c, 'matched'), once(d, 'matched')];
  d.emit('join-invite', { locator: invite.locator }); await Promise.all(matches);
  await secure(c, d);
  // Begin near a window boundary to keep this small burst in one quota window.
  await new Promise(resolve => setTimeout(resolve, 1020 - Date.now() % 1000));
  let rejected = 0;
  for (let i = 0; i < 55; i++) {
    const result = await ack(a, 'send-encrypted', { encrypted: 'AAAA', messageId: crypto.randomUUID() });
    if (!result.ok) { rejected++; assert.equal(result.retryable, true); }
  }
  assert.ok(rejected > 0);
  const received = once(d, 'receive-encrypted');
  const payload = { encrypted: 'AAAA', messageId: crypto.randomUUID() };
  assert.equal((await ack(c, 'send-encrypted', payload)).ok, true);
  assert.deepEqual(await received, payload);
  assert.ok(a.connected && b.connected && c.connected && d.connected);
});
