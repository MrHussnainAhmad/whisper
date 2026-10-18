/**
 * validation.js - Input validation for anonymous sessions
 */

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId);
}

function isValidMessageId(messageId) {
  return typeof messageId === 'string' && MESSAGE_ID_RE.test(messageId);
}

function isValidPublicKey(publicKey) {
  if (typeof publicKey !== 'string' || !PUBLIC_KEY_RE.test(publicKey)) return false;
  try {
    return Buffer.from(publicKey, 'base64').length === 32;
  } catch {
    return false;
  }
}

function isValidKeyBundle(value) {
  if (!isValidBase64(value, 16384) || value.length < 128) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes[0] === 7 && bytes.toString('base64') === value;
}

function isValidBase64(value, maxCharacters) {
  if (typeof value !== 'string' || value.length === 0 ||
      value.length > maxCharacters || value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const end = value.length - padding;
  // Constant stack space even for multi-megabyte attachments. Do not decode
  // merely to validate: that would allocate another copy of the payload.
  for (let i = 0; i < end; i += 1) {
    const c = value.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
          (c >= 48 && c <= 57) || c === 43 || c === 47)) return false;
  }
  return true;
}

module.exports = { isValidSessionId, isValidMessageId, isValidPublicKey, isValidKeyBundle, isValidBase64 };
