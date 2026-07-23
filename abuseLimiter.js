/** Layered ephemeral abuse controls with renewable per-socket leases. */
const crypto = require('crypto');
const proxyaddr = require('proxy-addr');
const ipaddr = require('ipaddr.js');
const { REDIS_URL, getRedisClient } = require('./redisClient');
const { TRUST_PROXY_HOPS } = require('./networkConfig');
const { recordSecurityEvent } = require('./securityMonitor');

const USE_REDIS = !!REDIS_URL;
function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
const MAX_CONNECTIONS_PER_SOURCE = positiveIntegerEnv('MAX_CONNECTIONS_PER_SOURCE', 24);
const MAX_CONNECTIONS_GLOBAL = positiveIntegerEnv('MAX_CONNECTIONS_GLOBAL', 5000);
const CONNECTION_LEASE_MS = 90_000;

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

  if (!USE_REDIS) {
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
    return true;
  }

  const client = await getRedisClient();
  const now = Date.now();
  const expiresAt = now + CONNECTION_LEASE_MS;
  const accepted = await client.eval(
    `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
     redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
     if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then return -1 end
     if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
     redis.call('ZADD', KEYS[1], ARGV[5], ARGV[2])
     redis.call('ZADD', KEYS[2], ARGV[5], ARGV[2])
     redis.call('PEXPIRE', KEYS[1], ARGV[6])
     redis.call('PEXPIRE', KEYS[2], ARGV[6])
     return 1`,
    {
      keys: [`abuse:connections:source:${sourceKey}`, 'abuse:connections:global'],
      arguments: [
        String(now), member, String(MAX_CONNECTIONS_PER_SOURCE),
        String(MAX_CONNECTIONS_GLOBAL), String(expiresAt), String(CONNECTION_LEASE_MS * 2),
      ],
    }
  );
  socket.data.connectionLeaseActive = Number(accepted) === 1;
  if (!socket.data.connectionLeaseActive) {
    recordSecurityEvent(Number(accepted) === -1
      ? 'connection-global-limit'
      : 'connection-source-limit');
  }
  return socket.data.connectionLeaseActive;
}

async function refreshConnection(socket) {
  if (!USE_REDIS || !socket.connected || !socket.data?.connectionLeaseActive) return;
  const sourceKey = socket.data?.sourceKey;
  const member = socket.data?.connectionLeaseMember;
  if (!sourceKey || !member) return;
  const client = await getRedisClient();
  if (!socket.connected || !socket.data?.connectionLeaseActive) return;
  const expiresAt = Date.now() + CONNECTION_LEASE_MS;
  const multi = client.multi();
  multi.zAdd(`abuse:connections:source:${sourceKey}`, [{ score: expiresAt, value: member }]);
  multi.pExpire(`abuse:connections:source:${sourceKey}`, CONNECTION_LEASE_MS * 2);
  multi.zAdd('abuse:connections:global', [{ score: expiresAt, value: member }]);
  multi.pExpire('abuse:connections:global', CONNECTION_LEASE_MS * 2);
  await multi.exec();
}

/** Refresh all active Redis connection leases in one round trip. */
async function refreshConnections(sockets) {
  if (!USE_REDIS) return;
  const active = [...sockets].filter((socket) =>
    socket.connected && socket.data?.connectionLeaseActive &&
    socket.data?.sourceKey && socket.data?.connectionLeaseMember
  );
  if (!active.length) return;

  const client = await getRedisClient();
  const expiresAt = Date.now() + CONNECTION_LEASE_MS;
  const sourceEntries = new Map();
  const multi = client.multi();
  for (const socket of active) {
    const sourceKey = `abuse:connections:source:${socket.data.sourceKey}`;
    const member = socket.data.connectionLeaseMember;
    const entries = sourceEntries.get(sourceKey) || [];
    entries.push({ score: expiresAt, value: member });
    sourceEntries.set(sourceKey, entries);
  }
  for (const [sourceKey, entries] of sourceEntries) {
    multi.zAdd(sourceKey, entries);
    multi.pExpire(sourceKey, CONNECTION_LEASE_MS * 2);
  }
  multi.zAdd('abuse:connections:global', active.map((socket) => ({
    score: expiresAt,
    value: socket.data.connectionLeaseMember,
  })));
  multi.pExpire('abuse:connections:global', CONNECTION_LEASE_MS * 2);
  await multi.exec();
}

async function releaseConnection(socket) {
  const sourceKey = socket.data?.sourceKey;
  const member = socket.data?.connectionLeaseMember;
  if (!sourceKey || !member) return;
  socket.data.connectionLeaseActive = false;

  if (!USE_REDIS) {
    const sourceMembers = connections.get(sourceKey);
    sourceMembers?.delete(member);
    globalConnections.delete(member);
    if (sourceMembers?.size === 0) connections.delete(sourceKey);
    return;
  }

  const client = await getRedisClient();
  const multi = client.multi();
  multi.zRem(`abuse:connections:source:${sourceKey}`, member);
  multi.zRem('abuse:connections:global', member);
  await multi.exec();
}

function consumeMemory(bucket, identity, limit, windowMs, cost = 1) {
  if (!identity || !Number.isFinite(cost) || cost < 1) return false;
  const key = `${bucket}:${identity}`;
  const now = Date.now();
  let entry = counters.get(key);
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

  if (!USE_REDIS) {
    if (!consumeMemory(`${action}:source`, sourceKey, sourceLimit, windowMs, cost)) {
      recordSecurityEvent('socket-rate-limited');
      return false;
    }
    const allowed = consumeMemory(`${action}:session`, sessionId, limit, windowMs, cost);
    if (!allowed) recordSecurityEvent('socket-rate-limited');
    return allowed;
  }

  const client = await getRedisClient();
  const result = await client.eval(
    `local source = redis.call('INCRBY', KEYS[1], ARGV[1])
     if source == tonumber(ARGV[1]) then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
     if source > tonumber(ARGV[3]) then return 0 end
     local session = redis.call('INCRBY', KEYS[2], ARGV[1])
     if session == tonumber(ARGV[1]) then redis.call('PEXPIRE', KEYS[2], ARGV[2]) end
     if session > tonumber(ARGV[4]) then return 0 end
     return 1`,
    {
      keys: [`abuse:${action}:source:${sourceKey}`, `abuse:${action}:session:${sessionId}`],
      arguments: [
        String(Math.ceil(cost)), String(windowMs), String(sourceLimit), String(limit),
      ],
    }
  );
  const allowed = Number(result) === 1;
  if (!allowed) recordSecurityEvent('socket-rate-limited');
  return allowed;
}

module.exports = {
  acquireConnection,
  refreshConnection,
  refreshConnections,
  releaseConnection,
  allowAction,
  getSourceKey,
  normalizeSource,
  CONNECTION_LEASE_MS,
};
