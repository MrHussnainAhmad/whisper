const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const { once } = require('node:events');
const { parseProxyHeader, getOnionSource } = require('../torProxy');
const { createOnionBoundary, onionConfig, listenOnion } = require('../onionListener');
const header = (id = '1', prefix = 'fc00') => `PROXY TCP6 ${prefix}::${id} ::1 0 80\r\n`;

test('Tor PROXY validates v1 TCP6 and ignores upper 96 bits, destination and ports', () => {
  const parse = value => parseProxyHeader(Buffer.from(value));
  assert.equal(parse(header('12', 'fc00')), parse(header('12', '2001')));
  assert.notEqual(parse(header('12')), parse(header('13')));
  assert.equal(parse(header('ffff:ffff')), parse('PROXY TCP6 2001:db8:1:2:3:4:ffff:ffff 2001:db8::99 65535 1234\r\n'));
  for (const bad of [header().replace('TCP6', 'TCP4'), header().replace('::1', '127.0.0.1'),
    header().replace('0 80', '-1 80'), header().replace('0 80', '65536 80'),
    header().replace('0 80', '0 65536'), header().replace('fc00::1', 'fc00::1%eth0'),
    'PROXY UNKNOWN\r\n', 'PROXY TCP6 ::1 ::1 1 80\n', header() + 'x',
    '\r\n\r\n\0\r\nQUIT\n', 'X'.repeat(109), header().replace('TCP6 ', 'TCP6  ')]) {
    assert.throws(() => parse(bad));
  }
});

async function setup(t, overrides = {}, httpOptions = {}) {
  let reached = 0;
  const httpServer = http.createServer((req, res) => {
    reached++; res.end(`${req.url}|${getOnionSource(req) ? 'trusted' : 'untrusted'}`);
  });
  Object.assign(httpServer, httpOptions);
  const gate = createOnionBoundary(httpServer, { ...onionConfig({}), headerTimeout: 80, ...overrides });
  gate.activate(); gate.server.listen(0, '127.0.0.1'); await once(gate.server, 'listening');
  t.after(() => gate.close());
  return { gate, reached: () => reached, connect: () => net.connect(gate.server.address().port, '127.0.0.1') };
}
async function response(connect, chunks) {
  const socket = connect(); socket.on('error', () => {});
  let output = ''; socket.on('data', chunk => { output += chunk; });
  const closed = new Promise(resolve => socket.once('close', resolve));
  await once(socket, 'connect');
  for (const chunk of chunks) { socket.write(chunk); await new Promise(resolve => setImmediate(resolve)); }
  await closed; return output;
}
test('fragmented/coalesced PROXY preserves HTTP bytes exactly and rejects bypass/spoof input', async t => {
  const fixture = await setup(t);
  const request = 'GET /exact?abc=123 HTTP/1.1\r\nHost: anything\r\nConnection: close\r\n\r\n';
  assert.match(await response(fixture.connect, [header().slice(0, 17), header().slice(17) + request]), /\/exact\?abc=123\|trusted/);
  assert.match(await response(fixture.connect, [header('2') + request]), /200 OK/);
  for (const chunks of [[request], ['X'.repeat(50000)], ['PROXY TCP6'],
    [header() + header() + request], ['GET / HTTP/1.1\r\nX-Onion: true\r\n\r\n']]) {
    assert.doesNotMatch(await response(fixture.connect, chunks), /200 OK/);
  }
  assert.equal(fixture.reached(), 2);
  assert.deepEqual(fixture.gate.stats(), { streams: 0, pending: 0, circuits: 0 });
});

test('pending/global/circuit raw stream limits are bounded and released on shutdown', async t => {
  const fixture = await setup(t, { perCircuit: 1, maxStreams: 3, maxPending: 1, headerTimeout: 500 });
  const sockets = [];
  const open = async value => {
    const s = fixture.connect(); s.on('error', () => {}); sockets.push(s);
    await once(s, 'connect'); if (value) s.write(value);
    await new Promise(resolve => setTimeout(resolve, 20)); return s;
  };
  t.after(() => sockets.forEach(s => s.destroy()));
  const first = await open(header('1'));
  const duplicate = await open(header('1', '2001'));
  assert.equal(duplicate.destroyed, true);
  const second = await open(header('2'));
  assert.equal(second.destroyed, false);
  const pending = await open('PROXY');
  const excess = await open(header('3'));
  assert.equal(excess.destroyed, true);
  assert.equal(fixture.gate.stats().streams, 3);
  await fixture.gate.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(fixture.gate.stats(), { streams: 0, pending: 0, circuits: 0 });
  assert.ok(first.destroyed && second.destroyed && pending.destroyed);
});

test('onion listener is opt-in and never falls back to TCP on Windows', async () => {
  assert.equal(onionConfig({}).enabled, false);
  assert.throws(() => onionConfig({ ONION_ENABLED: 'true' }));
  if (process.platform === 'win32') await assert.rejects(listenOnion({}, onionConfig({})), /Unix/);
});

test('HTTP header deadline rejects trickle input after a valid PROXY header', async t => {
  const fixture = await setup(t, {}, {
    headersTimeout: 100, requestTimeout: 200, connectionsCheckingInterval: 20,
  });
  const serverClosed = new Promise(resolve => {
    fixture.gate.server.once('connection', incoming => incoming.once('close', resolve));
  });
  const socket = fixture.connect(); socket.on('error', () => {});
  const closed = new Promise(resolve => socket.once('close', resolve));
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.resume();
  socket.write(header() + 'GET / HTTP/1.1\r\nX-Slow: ');
  const trickle = setInterval(() => socket.write('a'), 15);
  t.after(() => clearInterval(trickle));
  await closed;
  await serverClosed;
  clearInterval(trickle);
  assert.equal(fixture.reached(), 0);
  assert.equal(fixture.gate.stats().streams, 0);
});
