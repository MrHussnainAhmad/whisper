const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const invites = require('../invites');
const { normalizeInviteLocator } = require('../inviteRateLimiter');
const { allowAction } = require('../abuseLimiter');
test('lookup alphabet, normalization, expiry, collision retry and one use', t => {
  for (let i = 0; i < 100; i++) assert.match(invites.generateInviteLocator(), /^[0-9A-Z]{6}$/);
  assert.equal(normalizeInviteLocator('ab c-d ef'), 'ABCDEF');
  for (const char of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') assert.equal(normalizeInviteLocator(char.repeat(6)), char.repeat(6));
  assert.equal(normalizeInviteLocator('ABC_EF'), null);
  assert.equal(normalizeInviteLocator('TALK-AAAA-AAAA-AAAA-AAAA'), null);
  t.mock.method(crypto, 'randomInt', () => 0);
  const code = invites.createInvite('first', 'socket');
  assert.throws(() => invites.createInvite('second', 'socket2'), /allocate/);
  t.mock.restoreAll();
  const second = invites.createInvite('second', 'socket2');
  assert.notEqual(code, second);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + invites.INVITE_TTL_MS);
  assert.equal(invites.getInvite(code), null); t.mock.restoreAll();
  assert.ok(invites.consumeInvite(second, 'second')); assert.equal(invites.consumeInvite(second, 'second'), null);
});
test('all 36 alphabet symbols are reachable through bounded cryptographic randomInt', t => {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let index = 0; index < alphabet.length; index++) {
    t.mock.method(crypto, 'randomInt', max => { assert.equal(max, 36); return index; });
    assert.equal(invites.generateInviteLocator(), alphabet[index].repeat(6));
    t.mock.restoreAll();
  }
});
test('connection, source and global attempt caps lock out until window expires', async t => {
  const socket = { sessionId: 'a', data: { sourceKey: 'ip-a' } };
  const options = { limit: 2, sourceLimit: 3, globalLimit: 4, windowMs: 60000 };
  const action = crypto.randomUUID();
  assert.equal(await allowAction(socket, action, options), true);
  assert.equal(await allowAction(socket, action, options), true);
  assert.equal(await allowAction(socket, action, options), false);
  socket.sessionId = 'b'; assert.equal(await allowAction(socket, action, options), false);
  socket.data.sourceKey = 'ip-b'; assert.equal(await allowAction(socket, action, options), false);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 60001);
  assert.equal(await allowAction(socket, action, options), true);
});
