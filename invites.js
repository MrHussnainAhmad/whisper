/** Short-lived lookup IDs only; never encryption keys or peer authentication. */
const INVITE_TTL_MS = Number(process.env.INVITE_TTL_MS || 600000);
if (!Number.isSafeInteger(INVITE_TTL_MS) || INVITE_TTL_MS < 1000 || INVITE_TTL_MS > 3600000) throw new Error('Invalid INVITE_TTL_MS');
const CLEANUP_INTERVAL_MS = 30 * 1000;
const invites = new Map();
const INVITE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function generateInviteLocator() {
  return Array.from({ length: 6 }, () => INVITE_ALPHABET[require('crypto').randomInt(INVITE_ALPHABET.length)]).join('');
}

function createInvite(sessionId, socketId, requestId = null) {
  const existing = getInviteForRequest(sessionId, requestId);
  if (existing) return existing;
  cancelInvite(sessionId);
  for (let attempt = 0; attempt < 20; attempt++) {
    const locator = generateInviteLocator();
    if (!invites.has(locator)) {
      invites.set(locator, { sessionId, socketId, requestId, createdAt: Date.now() });
      return locator;
    }
  }
  throw new Error('Failed to allocate invite locator');
}

function getInviteForRequest(sessionId, requestId) {
  if (!requestId) return null;
  for (const [locator, invite] of invites) {
    if (invite.sessionId === sessionId && invite.requestId === requestId && getInvite(locator)) return locator;
  }
  return null;
}

function getInvite(locator) {
  const invite = invites.get(locator);
  if (!invite) return null;
  if (Date.now() - invite.createdAt >= INVITE_TTL_MS) {
    invites.delete(locator);
    return null;
  }
  return invite;
}

/** Atomically consume a locator only if it still belongs to expectedSessionId. */
function consumeInvite(locator, expectedSessionId) {
  const invite = getInvite(locator);
  if (!invite || invite.sessionId !== expectedSessionId) return null;
  invites.delete(locator);
  return invite;
}

function cancelInvite(sessionId) {
  for (const [locator, invite] of invites) {
    if (invite.sessionId === sessionId) {
      invites.delete(locator);
      return true;
    }
  }
  return false;
}

function hasInvite(sessionId) {
  for (const [locator, invite] of invites) {
    if (Date.now() - invite.createdAt >= INVITE_TTL_MS) {
      invites.delete(locator);
      continue;
    }
    if (invite.sessionId === sessionId) return true;
  }
  return false;
}

/** Restore a still-valid invite after a failed room claim. */
function _restoreInvite(locator, invite) {
  if (!invite) return false;
  if (Date.now() - invite.createdAt >= INVITE_TTL_MS) return false;
  if (invites.has(locator)) return false;
  invites.set(locator, {
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
    if (now - invite.createdAt >= INVITE_TTL_MS) invites.delete(locator);
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
