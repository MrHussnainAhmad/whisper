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


module.exports = { fixture, ack, event, secure, match };
