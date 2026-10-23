const test = require('node:test');
const assert = require('node:assert/strict');
const { createProofOfWork, validWork, powConfig } = require('../proofOfWork');
function solve(c) { for (let n = 0; n < 1000000; n++) if (validWork(c, String(n))) return String(n); throw new Error('No solution'); }
test('PoW is opt-in, operation/session-bound, single-use, and issues one-use reconnect tickets', t => {
  assert.equal(powConfig({}).enabled, false);
  assert.throws(() => powConfig({ ONION_APP_POW_BITS: '30' }));
  const pow = createProofOfWork({ difficulty: 8 }); t.after(() => pow.close());
  const c = pow.issue('session-a', 'find-random'); const solution = solve(c);
  assert.equal(pow.solve('session-b', c.id, solution), null);
  const proof = pow.solve('session-a', c.id, solution); assert.ok(proof.ticket);
  assert.equal(pow.solve('session-a', c.id, solution), null);
  assert.equal(pow.consume(proof.ticket, 'create-invite'), false);
  assert.equal(pow.consume(proof.ticket, 'find-random'), true);
  assert.equal(pow.consume(proof.ticket, 'find-random'), false);
  assert.equal(pow.issue('a', 'send-encrypted'), null);
});
test('PoW expires, rejects malformed/replayed solutions, bounds memory and cleans disconnected owners', t => {
  const pow = createProofOfWork({ difficulty: 8, maxEntries: 2, challengeTtl: 50, ticketTtl: 30 });
  t.after(() => pow.close());
  let now = 100; t.mock.method(Date, 'now', () => now);
  const old = pow.issue('a', 'find-random'); const c = pow.issue('a', 'find-random');
  assert.equal(pow.solve('a', old.id, solve(old)), null);
  pow.issue('b', 'find-random'); assert.equal(pow.issue('c', 'find-random'), null);
  assert.equal(pow.solve('a', c.id, '1'.repeat(10000)), null);
  const d = pow.issue('a', 'create-invite'); const proof = pow.solve('a', d.id, solve(d));
  now += 31; assert.equal(pow.consume(proof.ticket, 'create-invite'), false);
  pow.forget('b'); assert.deepEqual(pow.stats(), { challenges: 0, tickets: 0, owners: 0 });
  const expired = pow.issue('a', 'create-invite'); now += 51;
  assert.equal(pow.solve('a', expired.id, solve(expired)), null);
  assert.deepEqual(pow.stats(), { challenges: 0, tickets: 0, owners: 0 });
});
module.exports = { solve };
