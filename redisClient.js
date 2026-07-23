// LayerBase exposes a Valkey-compatible Redis URL. Keep REDIS_URL as a
// backwards-compatible fallback for existing deployments.
const REDIS_URL = process.env.VALKEY_URL || process.env.REDIS_URL;
let clientPromise = null;
let redisLib = null;
let pubClient = null;
let subClient = null;
let keepAliveTimer = null;

const KEEP_ALIVE_INTERVAL_MS = 30 * 60 * 1000;
const KEEP_ALIVE_HEALTH_KEY = 'valkey:health';

function loadRedis() {
  if (redisLib) return redisLib;
  try {
    redisLib = require('redis');
  } catch (err) {
    throw new Error('Redis package not installed. Run `npm install` in backend.');
  }
  return redisLib;
}

async function getRedisClient() {
  if (!REDIS_URL) return null;
  if (clientPromise) return clientPromise;

  const { createClient } = loadRedis();
  const client = createClient({ url: REDIS_URL });
  client.on('error', (err) => {
    console.error('Valkey error:', err?.message || err);
  });

  clientPromise = client.connect().then(() => client);
  return clientPromise;
}

async function getRedisAdapterClients() {
  const client = await getRedisClient();
  if (!client) return null;

  if (pubClient && subClient) return { pubClient, subClient };

  pubClient = client.duplicate();
  subClient = client.duplicate();
  for (const adapterClient of [pubClient, subClient]) {
    adapterClient.on('error', (err) => {
      console.error('Valkey adapter client error:', err?.message || err);
    });
  }
  await pubClient.connect();
  await subClient.connect();
  return { pubClient, subClient };
}

async function sendKeepAlive() {
  const client = await getRedisClient();
  try {
    await client.ping();
  } catch {
    // PING is supported by Valkey, but retain a harmless fallback for managed
    // providers that restrict it.
    await client.get(KEEP_ALIVE_HEALTH_KEY);
  }
}

function startKeepAlive() {
  if (!REDIS_URL || keepAliveTimer) return false;

  keepAliveTimer = setInterval(() => {
    sendKeepAlive()
      .catch((err) => {
        console.error('Valkey keep-alive failed:', err?.message || err);
      });
  }, KEEP_ALIVE_INTERVAL_MS);
  keepAliveTimer.unref();
  return true;
}

function stopKeepAlive() {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

async function closeRedisConnections() {
  stopKeepAlive();

  const clients = [subClient, pubClient];
  const client = clientPromise ? await clientPromise.catch(() => null) : null;
  if (client) clients.push(client);

  await Promise.all(clients.map(async (redisClient) => {
    if (!redisClient?.isOpen) return;
    try {
      await redisClient.quit();
    } catch (err) {
      console.error('Valkey shutdown error:', err?.message || err);
      redisClient.disconnect();
    }
  }));

  pubClient = null;
  subClient = null;
  clientPromise = null;
}

async function verifyEphemeralRedisConfiguration() {
  if (!REDIS_URL || process.env.NODE_ENV !== 'production') return;
  if (process.env.REDIS_REQUIRE_EPHEMERAL !== 'true') {
    throw new Error('REDIS_REQUIRE_EPHEMERAL=true is required for production Redis');
  }

  const client = await getRedisClient();
  let appendOnly;
  let save;
  try {
    const aofConfig = await client.configGet('appendonly');
    const saveConfig = await client.configGet('save');
    appendOnly = aofConfig.appendonly;
    save = saveConfig.save;
  } catch {
    throw new Error('Cannot verify Redis persistence settings; CONFIG GET must be permitted');
  }
  if (String(appendOnly).toLowerCase() !== 'no' || String(save || '').trim() !== '') {
    throw new Error('Redis persistence must be disabled (appendonly=no and save="")');
  }
}

module.exports = {
  REDIS_URL,
  getRedisClient,
  getRedisAdapterClients,
  sendKeepAlive,
  startKeepAlive,
  stopKeepAlive,
  closeRedisConnections,
  verifyEphemeralRedisConfiguration,
};
