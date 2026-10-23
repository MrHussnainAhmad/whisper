const ipaddr = require('ipaddr.js');
const { isIP } = require('node:net');
const crypto = require('node:crypto');
const metadata = new WeakMap();
const requests = new WeakMap();
const secret = crypto.randomBytes(32);
const MAX_HEADER_BYTES = 108;

function parseProxyHeader(line) {
  if (!Buffer.isBuffer(line) || line.length > MAX_HEADER_BYTES ||
      !line.every(byte => byte === 13 || byte === 10 || (byte >= 32 && byte <= 126))) throw new Error('Invalid PROXY header');
  const match = /^PROXY TCP6 ([^ ]+) ([^ ]+) ([0-9]{1,5}) ([0-9]{1,5})\r\n$/.exec(line.toString('ascii'));
  if (!match || isIP(match[1]) !== 6 || isIP(match[2]) !== 6 ||
      match[1].includes('%') || match[2].includes('%') || Number(match[3]) > 65535 || Number(match[4]) > 65535) {
    throw new Error('Invalid PROXY header');
  }
  // Tor specifies that the upper 96 bits, destination, and ports are ignored.
  const bytes = ipaddr.parse(match[1]).toByteArray();
  const circuit = Buffer.from(bytes.slice(12));
  return crypto.createHmac('sha256', secret).update(circuit).digest('hex');
}

function getOnionSource(req) {
  if (!req) return undefined;
  if (requests.has(req)) return requests.get(req);
  const key = metadata.get(req.socket);
  if (key !== undefined) requests.set(req, key);
  return key;
}
function isOnionRequest(req) { return getOnionSource(req) !== undefined; }

// Only invoke on sockets accepted by the protected Unix listener. No HTTP
// header or public-listener path can set metadata in this private WeakMap.
function acceptProxySocket(socket, { timeoutMs, admit, ready }) {
  let prefix = Buffer.alloc(0), finished = false;
  const timer = setTimeout(() => socket.destroy(), timeoutMs); timer.unref();
  const cleanup = () => { clearTimeout(timer); socket.off('data', onData); prefix = null; };
  socket.once('close', () => { cleanup(); metadata.delete(socket); });
  socket.on('error', () => {});
  function onData(chunk) {
    if (finished) return;
    // Copy at most 108 bytes, even if a sender delivers a huge first chunk.
    const previous = prefix.length;
    const sample = Buffer.concat([prefix, chunk.subarray(0, MAX_HEADER_BYTES - previous)]);
    const end = sample.indexOf('\r\n');
    if (end < 0) {
      if (sample.length >= MAX_HEADER_BYTES) { socket.destroy(); return; }
      prefix = sample; return;
    }
    let key;
    try { key = parseProxyHeader(sample.subarray(0, end + 2)); } catch { socket.destroy(); return; }
    if (!admit(key)) { socket.destroy(); return; }
    finished = true;
    socket.pause(); cleanup();
    metadata.set(socket, key);
    const consumed = end + 2 - previous;
    if (chunk.length > consumed) socket.unshift(chunk.subarray(consumed));
    ready(socket);
    socket.resume();
  }
  socket.on('data', onData);
}
module.exports = { parseProxyHeader, acceptProxySocket, getOnionSource, isOnionRequest, MAX_HEADER_BYTES };
