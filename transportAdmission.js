const { isOnionRequest } = require('./torProxy');
const { getSourceKey } = require('./abuseLimiter');
const { ENFORCE_HTTPS, isSecureRequest } = require('./security');

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

// Count Engine.IO transports, including clients that never join Socket.IO.
// Reserve before allocation, rather than waiting for namespace middleware.
function createTransportAdmission(originPolicy) {
  const maxGlobal = positiveInteger('MAX_CONNECTIONS_GLOBAL', 5000);
  const maxSource = positiveInteger('MAX_CONNECTIONS_PER_SOURCE', 24);
  const maxCircuit = positiveInteger('ONION_CONNECTIONS_PER_CIRCUIT', 4);
  const maxOnion = Math.min(positiveInteger('ONION_MAX_CONNECTIONS', 1000), Math.max(1, Math.floor(maxGlobal / 2)));
  let onionTotal = 0;
  const sources = new Map();
  const reservations = new WeakMap();
  let total = 0;
  function allowRequest(req, callback) {
    const onion = isOnionRequest(req);
    if ((ENFORCE_HTTPS && !onion && !isSecureRequest(req)) ||
        (onion ? req.headers.origin !== undefined : !originPolicy.allowsRequestOrigin(req.headers.origin))) {
      callback('Transport not allowed', false); return;
    }
    const key = getSourceKey({ request: req });
    const count = sources.get(key) || 0;
    if (total >= maxGlobal || count >= (onion ? maxCircuit : maxSource) || (onion && onionTotal >= maxOnion)) {
      callback('Too many connections', false); return;
    }
    total += 1;
    if (onion) onionTotal++;
    sources.set(key, count + 1);
    let released = false;
    let timer;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      total -= 1;
      if (onion) onionTotal--;
      const remaining = (sources.get(key) || 1) - 1;
      if (remaining) sources.set(key, remaining); else sources.delete(key);
      reservations.delete(req);
    };
    timer = setTimeout(release, 10_000);
    timer.unref();
    reservations.set(req, { release, activate: () => clearTimeout(timer) });
    callback(null, true);
  }
  function onConnection(socket) {
    const lease = reservations.get(socket.request);
    if (!lease) { socket.close(true); return; }
    lease.activate();
    if (isOnionRequest(socket.request)) socket.request.socket.setTimeout(0);
    socket.once('close', lease.release);
  }
  return { allowRequest, onConnection };
}

module.exports = { createTransportAdmission };
