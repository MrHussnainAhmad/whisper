/** Parse ephemeral Redis values without allowing one corrupt key to crash an
 * event handler. Callers treat null as missing and let key TTLs remove it. */
function parseEphemeralJson(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

module.exports = { parseEphemeralJson };
