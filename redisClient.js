const REDIS_URL = process.env.REDIS_URL;
let clientPromise = null;
let redisLib = null;

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
    console.error('Redis error:', err?.message || err);
  });

  clientPromise = client.connect().then(() => client);
  return clientPromise;
}

async function getRedisAdapterClients() {
  const client = await getRedisClient();
  if (!client) return null;
  const pubClient = client.duplicate();
  const subClient = client.duplicate();
  await pubClient.connect();
  await subClient.connect();
  return { pubClient, subClient };
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
  verifyEphemeralRedisConfiguration,
};
