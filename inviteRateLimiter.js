/** Six-character lookup IDs have no cryptographic authentication role. */
function normalizeInviteLocator(value) {
  if (typeof value !== 'string' || value.length > 32) return null;
  const code = value.toUpperCase().replace(/[-\s]/g, '');
  return /^[0-9A-Z]{6}$/.test(code) ? code : null;
}
function isValidInviteLocator(value) { return normalizeInviteLocator(value) !== null; }
module.exports = { isValidInviteLocator, normalizeInviteLocator };
