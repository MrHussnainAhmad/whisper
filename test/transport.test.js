const test = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer } = require('./serverFixture.cjs');

test('production rejects cleartext Engine.IO before allocating a transport', async () => {
  const server = await startServer({ NODE_ENV: 'production' });
  try {
    for (const route of ['/health', '/socket.io/?EIO=4&transport=polling']) {
      const response = await fetch(server.url + route, { headers: { 'x-forwarded-proto': 'https' }, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 403);
    }
  } finally { server.stop(); }
});

test('clients that never join Socket.IO still consume transport admission slots', async () => {
  const server = await startServer({ MAX_CONNECTIONS_PER_SOURCE: '2', MAX_CONNECTIONS_GLOBAL: '2' });
  try {
    const url = server.url + '/socket.io/?EIO=4&transport=polling';
    for (let i = 0; i < 2; i++) {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /^0\{/);
    }
    assert.equal((await fetch(url, { signal: AbortSignal.timeout(5000) })).status, 403);
  } finally { server.stop(); }
});

test('forwarding headers only work when the immediate peer is explicitly trusted', async () => {
  for (const [cidr, expected] of [['192.0.2.1/32', 403], ['127.0.0.1/32', 200]]) {
    const server = await startServer({ NODE_ENV: 'production', TRUST_PROXY: '1', TRUST_PROXY_CIDRS: cidr });
    try {
      const response = await fetch(server.url + '/socket.io/?EIO=4&transport=polling', {
        headers: { 'x-forwarded-proto': 'https' }, signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, expected);
    } finally { server.stop(); }
  }
});

test('default server enables one-to-one search and rejects groups', async () => {
  const server = await startServer();
  const socket = io(server.url, { transports: ['websocket'], reconnection: false });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Session timed out')), 5000);
      socket.once('joined', () => { clearTimeout(timer); resolve(); });
    });
    for (const event of ['group-captcha', 'join-group']) {
      const response = await socket.timeout(3000).emitWithAck(event, {});
      assert.equal(response.ok, false);
      assert.match(response.error, /disabled/);
    }
    assert.equal((await socket.timeout(3000).emitWithAck('create-invite', {})).ok, true);
    assert.equal((await socket.timeout(3000).emitWithAck('find-random', {})).status, 'waiting');
  } finally { socket.disconnect(); server.stop(); }
});
