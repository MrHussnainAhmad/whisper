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

module.exports = {
  REDIS_URL,
  getRedisClient,
  getRedisAdapterClients,
};
