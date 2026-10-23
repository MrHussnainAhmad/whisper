const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { io } = require('socket.io-client');
const { validWork } = require('../proofOfWork');
const ack = (s, e, data = {}) => ['secure-channel-ready', 'verify-chat'].includes(e)
  ? s.timeout(3000).emitWithAck(e) : s.timeout(3000).emitWithAck(e, data);
function event(s, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { s.off(name, handler); reject(new Error(name + ' timeout')); }, 4000);
    function handler(data) { clearTimeout(timer); resolve(data); }
    s.once(name, handler);
  });
}
async function fixture(t, env = {}) {
  const child = fork(path.join(__dirname, 'phase1Server.cjs'), [], {
    env: { ...process.env, NODE_ENV: 'development', TRUST_PROXY: '0', CORS_ORIGIN: '', ONION_ENABLED: '0',
      ONION_APP_POW_ENABLED: '0', ...env }, silent: true,
  });
  let errors = ''; child.stderr.on('data', b => { errors += b; }); child.stdout.resume();
  const startup = Promise.race([event(child, 'message'), once(child, 'exit').then(() => { throw new Error(errors); })]);
  t.after(() => { if (child.connected) child.send('stop'); else child.kill(); });
  const addresses = await startup;
  const clients = [], bridges = [], streams = new Set();
  t.after(async () => {
    clients.forEach(s => s.disconnect()); streams.forEach(s => s.destroy());
    await Promise.all(bridges.map(b => new Promise(resolve => b.close(resolve))));
  });
  const bridge = async circuit => {
    const server = net.createServer(down => {
      const up = net.connect(addresses.onionPort, '127.0.0.1');
      for (const s of [up, down]) { streams.add(s); s.on('error', () => {}); s.on('close', () => streams.delete(s)); }
      up.once('connect', () => {
        up.write(`PROXY TCP6 2001:db8::${circuit.toString(16)} ::1 123 80\r\n`);
        down.pipe(up); up.pipe(down);
      });
      down.on('close', () => up.destroy()); up.on('close', () => down.destroy());
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); bridges.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  };
  const connect = async (circuit, options = {}) => {
    const url = circuit === null ? `http://127.0.0.1:${addresses.publicPort}` : await bridge(circuit);
    const s = io(url, { transports: ['websocket'], reconnection: false, forceNew: true, ...options });
    clients.push(s); await event(s, 'joined'); return s;
  };
  return { child, bridge, connect, ...addresses };
}
async function secure(a, b) {
  const keyBundle = Buffer.concat([Buffer.from([7]), crypto.randomBytes(128)]).toString('base64');
  for (const s of [a, b]) {
    assert.equal((await ack(s, 'key-exchange', { keyBundle, protocolVersion: 7 })).ok, true);
    assert.equal((await ack(s, 'key-confirm', { proof: 'AAAA' })).ok, true);
  }
  for (const s of [a, b]) assert.equal((await ack(s, 'secure-channel-ready')).ok, true);
}
async function match(a, b, dataA = {}, dataB = {}) {
  assert.equal((await ack(a, 'find-random', dataA)).status, 'waiting');
  const matched = event(a, 'matched');
  assert.equal((await ack(b, 'find-random', dataB)).status, 'matched'); await matched;
}
async function ticket(s, action) {
  const response = await ack(s, 'pow-challenge', { action }); assert.equal(response.ok, true);
  const c = response.challenge;
  let solution = 0; while (!validWork(c, String(solution))) solution++;
  const result = await ack(s, 'pow-solve', { id: c.id, solution: String(solution) });
  assert.equal(result.ok, true); return result.ticket;
}

test('onion WebSocket and public peers share random/invite rooms, relay ciphertext, and terminate', async t => {
  const f = await fixture(t); const a = await f.connect(1), b = await f.connect(null);
  await match(a, b); await secure(a, b);
  const payload = { encrypted: crypto.randomBytes(192 * 1024).toString('base64'), messageId: crypto.randomUUID() };
  const received = event(b, 'receive-encrypted'); assert.equal((await ack(a, 'send-encrypted', payload)).ok, true);
  assert.deepEqual(await received, payload);
  const ended = event(b, 'chat-ended'); await ack(a, 'leave-room'); await ended;
  const c = await f.connect(2); const invite = await ack(a, 'create-invite');
  const matches = [event(a, 'matched'), event(c, 'matched')]; c.emit('join-invite', { locator: invite.locator });
  await Promise.all(matches); await secure(a, c);
  const stopped = event(c, 'chat-ended'); await ack(a, 'block-peer'); await stopped;
});

test('onion polling works across streams; circuit switching and public/header spoofing fail closed', async t => {
  const f = await fixture(t, { NODE_ENV: 'production', TRUST_PROXY: '1', TRUST_PROXY_CIDRS: '127.0.0.1/32' });
  const a = await f.connect(10, { transports: ['polling'], upgrade: false });
  assert.equal((await ack(a, 'create-invite')).ok, true);
  assert.equal((await ack(a, 'pow-challenge', { action: 'find-random' })).ok, false);
  const sid = a.io.engine.id;
  const wrong = await f.bridge(11);
  const switched = await fetch(`${wrong}/socket.io/?EIO=4&transport=polling&sid=${sid}`);
  assert.equal(switched.status, 400);
  const publicSpoof = await fetch(`http://127.0.0.1:${f.publicPort}/health`, { headers: { 'X-Onion': 'true', 'X-Tor-Circuit': '10' } });
  assert.equal(publicSpoof.status, 403);
  const onion = await f.bridge(12);
  const allowed = await fetch(onion + '/health', { headers: { 'X-Forwarded-For': '203.0.113.8', 'X-Forwarded-Proto': 'garbage' } });
  assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('strict-transport-security'), null);
  assert.equal((await ack(a, 'create-invite')).ok, true);
});

test('circuit Engine.IO caps isolate users sharing the local address and release disconnected leases', async t => {
  const f = await fixture(t, { ONION_CONNECTIONS_PER_CIRCUIT: '1', ONION_MAX_CONNECTIONS: '2' });
  const a = await f.connect(1);
  const url = await f.bridge(1);
  const duplicate = io(url, { transports: ['websocket'], reconnection: false });
  t.after(() => duplicate.disconnect()); await event(duplicate, 'connect_error');
  const b = await f.connect(2);
  const fullUrl = await f.bridge(3);
  const full = io(fullUrl, { transports: ['websocket'], reconnection: false });
  t.after(() => full.disconnect()); await event(full, 'connect_error');
  const publicPeer = await f.connect(null); assert.ok(publicPeer.connected);
  a.disconnect(); await new Promise(resolve => setTimeout(resolve, 100));
  const replacement = await f.connect(1); assert.ok(replacement.connected && b.connected);
});

test('optional PoW gates onion discovery only; tickets survive a fresh session and cannot replay', async t => {
  const f = await fixture(t, { ONION_APP_POW_ENABLED: '1', ONION_APP_POW_BITS: '8' });
  const a = await f.connect(1), publicPeer = await f.connect(null);
  assert.equal((await ack(publicPeer, 'create-invite')).ok, true);
  assert.equal((await ack(a, 'find-random')).error, 'Proof of work required');
  const admissionTicket = await ticket(a, 'create-invite'); a.disconnect();
  const fresh = await f.connect(2);
  assert.equal((await ack(fresh, 'create-invite', { admissionTicket })).ok, true);
  assert.equal((await ack(fresh, 'create-invite', { admissionTicket })).error, 'Proof of work required');
  const randomTicket = await ticket(fresh, 'find-random');
  await match(fresh, publicPeer, { admissionTicket: randomTicket }); await secure(fresh, publicPeer);
  const payload = { encrypted: 'AAAA', messageId: crypto.randomUUID() };
  const received = event(publicPeer, 'receive-encrypted');
  assert.equal((await ack(fresh, 'send-encrypted', payload)).ok, true); assert.deepEqual(await received, payload);
});


test('PoW challenge issuance is rate limited and shutdown closes active onion streams', async t => {
  const f = await fixture(t, { ONION_APP_POW_ENABLED: '1', ONION_APP_POW_BITS: '8' });
  const a = await f.connect(1);
  for (let i = 0; i < 6; i++) assert.equal((await ack(a, 'pow-challenge', { action: 'find-random' })).ok, true);
  assert.equal((await ack(a, 'pow-challenge', { action: 'find-random' })).error, 'Rate limited');
  const disconnected = event(a, 'disconnect'); const exited = once(f.child, 'exit');
  f.child.send('stop'); await disconnected; assert.equal((await exited)[0], 0);
});
