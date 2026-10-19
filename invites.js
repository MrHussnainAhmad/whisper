/** Short-lived lookup IDs only; never encryption keys or peer authentication. */
const crypto = require('crypto');
const INVITE_TTL_MS = Number(process.env.INVITE_TTL_MS || 600000);
if (!Number.isSafeInteger(INVITE_TTL_MS) || INVITE_TTL_MS < 1000 || INVITE_TTL_MS > 3600000) throw new Error('Invalid INVITE_TTL_MS');
const CLEANUP_INTERVAL_MS = 30 * 1000;
const invites = new Map();
const sessionInvites = new Map();
const INVITE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const { INVITE_LOCATOR_LENGTH } = require('./inviteRateLimiter');
function generateInviteLocator() {
  return Array.from({ length: INVITE_LOCATOR_LENGTH }, () => INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)]).join('');
}

function storeInvite(locator, invite) {
  invites.set(locator, invite);
  let locators = sessionInvites.get(invite.sessionId);
  if (!locators) { locators = new Set(); sessionInvites.set(invite.sessionId, locators); }
  locators.add(locator);
}

function deleteInvite(locator) {
  const invite = invites.get(locator);
  if (!invite) return;
  invites.delete(locator);
  const locators = sessionInvites.get(invite.sessionId);
  locators?.delete(locator);
  if (locators?.size === 0) sessionInvites.delete(invite.sessionId);
}

function createInvite(sessionId, socketId, requestId = null) {
  const existing = getInviteForRequest(sessionId, requestId);
  if (existing) return existing;
  cancelInvite(sessionId);
  for (let attempt = 0; attempt < 20; attempt++) {
    const locator = generateInviteLocator();
    if (!invites.has(locator)) {
      storeInvite(locator, { sessionId, socketId, requestId, createdAt: Date.now() });
      return locator;
    }
  }
  throw new Error('Failed to allocate invite locator');
}

function getInviteForRequest(sessionId, requestId) {
  if (!requestId) return null;
  const locators = sessionInvites.get(sessionId);
  if (!locators) return null;
  for (const locator of [...locators]) {
    const invite = getInvite(locator);
    if (invite?.requestId === requestId) return locator;
  }
  return null;
}

function getInvite(locator) {
  const invite = invites.get(locator);
  if (!invite) return null;
  if (Date.now() - invite.createdAt >= INVITE_TTL_MS) {
    deleteInvite(locator);
    return null;
  }
  return invite;
}

/** Atomically consume a locator only if it still belongs to expectedSessionId. */
function consumeInvite(locator, expectedSessionId) {
  const invite = getInvite(locator);
  if (!invite || invite.sessionId !== expectedSessionId) return null;
  deleteInvite(locator);
  return invite;
}

function cancelInvite(sessionId) {
  const locators = sessionInvites.get(sessionId);
  if (!locators) return false;
  for (const locator of [...locators]) deleteInvite(locator);
  return true;
}

function hasInvite(sessionId) {
  const locators = sessionInvites.get(sessionId);
  if (!locators) return false;
  for (const locator of [...locators]) {
    if (getInvite(locator)) return true;
  }
  return false;
}

/** Restore a still-valid invite after a failed room claim. */
function _restoreInvite(locator, invite) {
  if (!invite) return false;
  if (Date.now() - invite.createdAt >= INVITE_TTL_MS) return false;
  if (invites.has(locator)) return false;
  storeInvite(locator, {
    sessionId: invite.sessionId,
    socketId: invite.socketId,
    requestId: invite.requestId || null,
    createdAt: invite.createdAt || Date.now(),
  });
  return true;
}

async function cleanupExpiredInvites() {
  const now = Date.now();
  for (const [locator, invite] of invites) {
    if (now - invite.createdAt >= INVITE_TTL_MS) deleteInvite(locator);
  }
}

{
  const cleanupTimer = setInterval(() => cleanupExpiredInvites().catch((err) => {
    console.error('Invite cleanup failed:', err?.message || err);
  }), CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

module.exports = {
  createInvite,
  getInviteForRequest,
  getInvite,
  consumeInvite,
  cancelInvite,
  hasInvite,
  cleanupExpiredInvites,
  INVITE_TTL_MS,
  generateInviteLocator,
  _restoreInvite,
};
