/** Server-visible format: 80-bit locator; a separate 80-bit secret stays client-side. */
function isValidInviteLocator(locator) {
  return typeof locator === 'string' &&
    /^TALK-[2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){3}$/.test(locator.toUpperCase().trim());
}

module.exports = { isValidInviteLocator };
