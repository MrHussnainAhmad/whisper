/** Layered abuse controls held only in this server process RAM. */
const crypto = require('crypto');
const proxyaddr = require('proxy-addr');
const ipaddr = require('ipaddr.js');
const { TRUST_PROXY_HOPS } = require('./networkConfig');
const { recordSecurityEvent } = require('./securityMonitor');

function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
const MAX_CONNECTIONS_PER_SOURCE = positiveIntegerEnv('MAX_CONNECTIONS_PER_SOURCE', 24);
const MAX_CONNECTIONS_GLOBAL = positiveIntegerEnv('MAX_CONNECTIONS_GLOBAL', 5000);
const MAX_RATE_LIMIT_BUCKETS = positiveIntegerEnv('MAX_RATE_LIMIT_BUCKETS', 100_000);

const counters = new Map();
const connections = new Map();
const globalConnections = new Set();

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of counters) {
    if (now >= entry.expiresAt) counters.delete(key);
  }
}, 60_000);
cleanupTimer.unref();

function normalizeSource(address) {
  try {
    let parsed = ipaddr.parse(String(address).split('%')[0]);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
    if (parsed.kind() === 'ipv4') return parsed.toString();
    const bytes = parsed.toByteArray();
    bytes.fill(0, 8); // IPv6 /64 aggregation prevents cheap /128 rotation.
    return Buffer.from(bytes).toString('hex');
  } catch {
    return String(address || 'unknown');
  }
}

function getSourceKey(socket) {
  let address = socket.request?.socket?.remoteAddress || socket.handshake?.address || 'unknown';
  if (TRUST_PROXY_HOPS > 0 && socket.request) {
    try {
      address = proxyaddr(socket.request, (_addr, index) => index < TRUST_PROXY_HOPS);
    } catch {
      // Fall back to the transport address when forwarding headers are malformed.
    }
  }
  return crypto.createHash('sha256').update(normalizeSource(address)).digest('hex');
}

async function acquireConnection(socket) {
  const sourceKey = getSourceKey(socket);
  const member = socket.id;
  socket.data.sourceKey = sourceKey;
  socket.data.connectionLeaseMember = member;
  socket.data.connectionLeaseActive = false;

  if (globalConnections.size >= MAX_CONNECTIONS_GLOBAL) {
    recordSecurityEvent('connection-global-limit');
    return false;
  }
  let sourceMembers = connections.get(sourceKey);
  if (!sourceMembers) sourceMembers = new Set();
  if (sourceMembers.size >= MAX_CONNECTIONS_PER_SOURCE) {
    recordSecurityEvent('connection-source-limit');
    return false;
  }
  sourceMembers.add(member);
  globalConnections.add(member);
  connections.set(sourceKey, sourceMembers);
  socket.data.connectionLeaseActive = true;
  // Admission happens before the Socket.IO connection event. Release even if
  // the transport closes during middleware and never reaches that event.
  socket.conn?.once('close', () => {
    releaseConnection(socket).catch(() => recordSecurityEvent('connection-release-error'));
  });
  return true;
}

async function releaseConnection(socket) {
  const sourceKey = socket.data?.sourceKey;
  const member = socket.data?.connectionLeaseMember;
  if (!sourceKey || !member) return;
  socket.data.connectionLeaseActive = false;

  const sourceMembers = connections.get(sourceKey);
  sourceMembers?.delete(member);
  globalConnections.delete(member);
  if (sourceMembers?.size === 0) connections.delete(sourceKey);
  return;
}

function consumeMemory(bucket, identity, limit, windowMs, cost = 1) {
  if (!identity || !Number.isFinite(cost) || cost < 1) return false;
  const key = `${bucket}:${identity}`;
  const now = Date.now();
  let entry = counters.get(key);
  // Refuse new identities when full; do not evict live limits to admit abuse.
  if (!entry && counters.size >= MAX_RATE_LIMIT_BUCKETS) return false;
  if (!entry || now >= entry.expiresAt) entry = { value: 0, expiresAt: now + windowMs };
  if (entry.value + cost > limit) {
    counters.set(key, entry);
    return false;
  }
  entry.value += cost;
  counters.set(key, entry);
  return true;
}

async function allowAction(socket, action, options = {}) {
  const limit = options.limit ?? 30;
  const sourceLimit = options.sourceLimit ?? limit;
  const windowMs = options.windowMs ?? 60_000;
  const cost = options.cost ?? 1;
  const sourceKey = socket.data?.sourceKey;
  const sessionId = socket.sessionId;
  if (!sourceKey || !sessionId || !Number.isFinite(cost) || cost < 1) return false;

  if (!consumeMemory(`${action}:source`, sourceKey, sourceLimit, windowMs, cost)) {
    recordSecurityEvent('socket-rate-limited');
    return false;
  }
  const allowed = consumeMemory(`${action}:session`, sessionId, limit, windowMs, cost);
  if (!allowed) recordSecurityEvent('socket-rate-limited');
  return allowed;
}

module.exports = {
  acquireConnection,
  releaseConnection,
  allowAction,
  getSourceKey,
  normalizeSource,
};
