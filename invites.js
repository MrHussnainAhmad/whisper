/**
 * invites.js - One-Time Invite Code System
 *
 * ANONYMITY GUARANTEE:
 * - Invite codes live only in memory (process RAM or Redis RAM).
 * - Codes auto-expire after 5 minutes.
 * - Codes are deleted immediately after first use.
 */

const crypto = require('crypto');
const { REDIS_URL, getRedisClient } = require('./redisClient');

const INVITE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 30 * 1000; // Sweep every 30 seconds

const USE_REDIS = !!REDIS_URL;
const invites = new Map();

const KEYS = {
  invite: (code) => `invite:${code}`,
  inviteBySession: (sid) => `inviteBySession:${sid}`,
};

/**
 * Generate a unique invite code in format TALK-XXXX.
 * The code is random and not tied to any identity.
 */
async function createInvite(sessionId, socketId) {
  if (!USE_REDIS) {
    const hex = crypto.randomBytes(2).toString('hex').toUpperCase();
    const code = `TALK-${hex}`;
    if (invites.has(code)) return createInvite(sessionId, socketId);
    invites.set(code, { sessionId, socketId, createdAt: Date.now() });
    return code;
  }

  const client = await getRedisClient();
  for (let attempt = 0; attempt < 10; attempt++) {
    const hex = crypto.randomBytes(2).toString('hex').toUpperCase();
    const code = `TALK-${hex}`;
    const data = { sessionId, socketId, createdAt: Date.now() };
    const ok = await client.set(KEYS.invite(code), JSON.stringify(data), {
      NX: true,
      PX: INVITE_TTL_MS,
    });
    if (ok) {
      await client.set(KEYS.inviteBySession(sessionId), code, { PX: INVITE_TTL_MS });
      return code;
    }
  }
  throw new Error('Failed to allocate invite code');
}

/**
 * Redeem an invite code. Returns the creator's info and deletes the code.
 * Returns null if code doesn't exist or has expired.
 */
async function redeemInvite(code) {
  if (!USE_REDIS) {
    const invite = invites.get(code);
    if (!invite) return null;
    if (Date.now() - invite.createdAt > INVITE_TTL_MS) {
      invites.delete(code);
      return null;
    }
    invites.delete(code);
    return invite;
  }

  const client = await getRedisClient();
  const raw = await client.get(KEYS.invite(code));
  if (!raw) return null;
  const invite = JSON.parse(raw);
  const multi = client.multi();
  multi.del(KEYS.invite(code));
  multi.del(KEYS.inviteBySession(invite.sessionId));
  await multi.exec();
  return invite;
}

/**
 * Cancel an invite (e.g. creator disconnected before anyone joined).
 */
async function cancelInvite(sessionId) {
  if (!USE_REDIS) {
    for (const [code, invite] of invites) {
      if (invite.sessionId === sessionId) {
        invites.delete(code);
        return true;
      }
    }
    return false;
  }

  const client = await getRedisClient();
  const code = await client.get(KEYS.inviteBySession(sessionId));
  if (!code) return false;
  const multi = client.multi();
  multi.del(KEYS.inviteBySession(sessionId));
  multi.del(KEYS.invite(code));
  await multi.exec();
  return true;
}

/**
 * Check if a session already has an active invite.
 */
async function hasInvite(sessionId) {
  if (!USE_REDIS) {
    for (const [, invite] of invites) {
      if (invite.sessionId === sessionId) return true;
    }
    return false;
  }

  const client = await getRedisClient();
  const code = await client.get(KEYS.inviteBySession(sessionId));
  return !!code;
}

/**
 * TTL cleanup - removes expired invite codes (memory mode only).
 */
async function cleanupExpiredInvites() {
  if (USE_REDIS) return;
  const now = Date.now();
  for (const [code, invite] of invites) {
    if (now - invite.createdAt > INVITE_TTL_MS) {
      invites.delete(code);
    }
  }
}

// Start periodic cleanup (memory mode only)
if (!USE_REDIS) {
  const cleanupTimer = setInterval(() => {
    cleanupExpiredInvites().catch(() => {});
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

module.exports = {
  createInvite,
  redeemInvite,
  cancelInvite,
  hasInvite,
  cleanupExpiredInvites,
};
