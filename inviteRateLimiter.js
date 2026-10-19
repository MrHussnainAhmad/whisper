/** Eight-character lookup IDs have no cryptographic authentication role. */
const INVITE_LOCATOR_LENGTH = 8;
const INVITE_LOCATOR_RE = new RegExp(`^[0-9A-Z]{${INVITE_LOCATOR_LENGTH}}$`);
function normalizeInviteLocator(value) {
  if (typeof value !== 'string' || value.length > 32) return null;
  const code = value.toUpperCase().replace(/[-\s]/g, '');
  return INVITE_LOCATOR_RE.test(code) ? code : null;
}
function isValidInviteLocator(value) { return normalizeInviteLocator(value) !== null; }
module.exports = { isValidInviteLocator, normalizeInviteLocator, INVITE_LOCATOR_LENGTH };
