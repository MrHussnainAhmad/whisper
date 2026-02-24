const express = require('express');
const cors = require('cors');
const { getSessionCount } = require('./sessions');
const { getQueueSize, getRoomCount } = require('./matchmaking');

const ALLOWED_ORIGINS = (() => {
  const raw = process.env.CORS_ORIGIN;
  if (!raw) return '*';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : '*';
})();

const ADMIN_KEY = process.env.ADMIN_KEY || '';

function isAdminRequest(req) {
  if (!ADMIN_KEY) return true;
  const headerKey = req.get('x-admin-key');
  const queryKey = req.query?.admin_key;
  return headerKey === ADMIN_KEY || queryKey === ADMIN_KEY;
}

// --- Express Setup ---
const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).send('Forbidden');
  return res.send('this is dumb test');
});

/**
 * Health check endpoint.
 * Returns only aggregate counts - no session IDs, no user data.
 */
app.get('/health', async (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    activeSessions: await getSessionCount(),
    waitingInQueue: await getQueueSize(),
    activeRooms: await getRoomCount(),
  });
});

module.exports = { app, ALLOWED_ORIGINS };
