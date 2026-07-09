/**
 * validation.js - Input validation for anonymous sessions
 */

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId);
}

function isValidPublicKey(publicKey) {
  if (typeof publicKey !== 'string' || !PUBLIC_KEY_RE.test(publicKey)) return false;
  try {
    return Buffer.from(publicKey, 'base64').length === 32;
  } catch {
    return false;
  }
}

function isValidBase64(value, maxCharacters) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxCharacters &&
    value.length % 4 === 0 &&
    BASE64_RE.test(value);
}

module.exports = { isValidSessionId, isValidPublicKey, isValidBase64 };
