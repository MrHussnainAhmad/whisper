const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sessions = require('../sessions');
const mm = require('../matchmaking');
const { allowRoomResource } = require('../roomLimiter');
const { allowAction } = require('../abuseLimiter');

function participants(t, count = 4) {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  for (const id of ids) sessions.addSession(id, id);
  t.after(() => {
    for (const id of ids) {
      const room = mm.getRoomBySessionId(id);
      if (room) mm.destroyRoom(room.roomId);
      mm.leaveQueue(id); sessions.removeSession(id);
    }
  });
  return ids;
}

test('blocks distinguish sessions on one IP, prevent invite bypass, and expire', t => {
  const [a, b, c] = participants(t);
  const now = Date.now();
  mm.blockPair(a, b);
  mm.joinQueue(a, a, 'same-ip');
  assert.equal(mm.joinQueue(b, b, 'same-ip'), null);
  const match = mm.joinQueue(c, c, 'same-ip');
  assert.equal(match.user1.sessionId, a);
  mm.destroyRoom(match.roomId); mm.leaveQueue(b);
  const room = { session1: { sessionId: a, socketId: a }, session2: { sessionId: b, socketId: b } };
  assert.equal(mm._setRoom('blocked-invite', room), false);
  t.mock.method(Date, 'now', () => now + 1800001);
  assert.equal(mm._setRoom('expired-block', room), true);
});

test('session removal and TTL expiry remove both block indexes', async t => {
  const [a, b] = participants(t);
  mm.blockPair(a, b); sessions.removeSession(a); sessions.addSession(a, a);
  mm.joinQueue(a, a); const match = mm.joinQueue(b, b);
  assert.ok(match); mm.destroyRoom(match.roomId);
  mm.blockPair(a, b);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + sessions.SESSION_TTL_MS + 1);
  const expired = await sessions.cleanupExpiredSessions();
  assert.equal(expired.length, 4);
  sessions.addSession(a, a); sessions.addSession(b, b);
  mm.joinQueue(a, a); assert.ok(mm.joinQueue(b, b));
});

test('busy rooms cannot debit another room share; budgets reset and new rooms get fresh state', t => {
  const ids = participants(t, 8);
  const rooms = [];
  for (let i = 0; i < ids.length; i += 2) {
    mm.joinQueue(ids[i], ids[i]);
    const match = mm.joinQueue(ids[i + 1], ids[i + 1]);
    mm.lockRoomSecureChannel(match.roomId);
    rooms.push(mm.getRoom(match.roomId));
  }
  let now = 100000; t.mock.method(Date, 'now', () => now);
  for (const room of rooms) {
    assert.equal(allowRoomResource(room, 'messages', 40, 1000, 10, 80), true);
    for (let i = 0; i < 100; i++) assert.equal(allowRoomResource(room, 'messages', 40, 1000, 1, 80), false);
  }
  now += 1000;
  assert.equal(allowRoomResource(rooms[0], 'messages', 40, 1000, 10, 80), true);
  assert.equal(allowRoomResource(rooms[0], 'bytes', 1000, 10000, 100, 250), true);
  assert.equal(allowRoomResource(rooms[1], 'bytes', 1000, 10000, 1, 250), false); // hard global/second cap
  now += 1000;
  assert.equal(allowRoomResource(rooms[1], 'bytes', 1000, 10000, 100, 250), true);
  const old = mm.getRoomBySessionId(ids[0]); mm.destroyRoom(old.roomId);
  mm.joinQueue(ids[0], ids[0]);
  const fresh = mm.getRoom(mm.joinQueue(ids[1], ids[1]).roomId);
  mm.lockRoomSecureChannel(sessions.getSession(ids[0]).roomId);
  assert.equal(allowRoomResource(fresh, 'messages', 40, 1000, 10, 80), true);
});

test('unconfirmed rooms do not dilute established capacity and teardown releases the count once', t => {
  const [a, b, c, d] = participants(t);
  const before = mm.getEstablishedRoomCount();
  mm.joinQueue(a, a); const first = mm.joinQueue(b, b);
  mm.joinQueue(c, c); const second = mm.joinQueue(d, d);
  assert.equal(mm.getEstablishedRoomCount(), before);
  mm.lockRoomSecureChannel(first.roomId); mm.lockRoomSecureChannel(first.roomId);
  assert.equal(mm.getEstablishedRoomCount(), before + 1);
  mm.destroyRoom(second.roomId);
  assert.equal(mm.getEstablishedRoomCount(), before + 1);
  mm.destroyRoom(first.roomId); mm.destroyRoom(first.roomId);
  assert.equal(mm.getEstablishedRoomCount(), before);
});

test('socket quotas remain independent on a shared IP; rejected floods do not drain global capacity', async () => {
  const a = { sessionId: 'a', data: { sourceKey: 'shared' } };
  const b = { sessionId: 'b', data: { sourceKey: 'shared' } };
  const action = crypto.randomUUID();
  const options = { limit: 2, sourceLimit: false, globalLimit: 4 };
  assert.equal(await allowAction(a, action, options), true);
  assert.equal(await allowAction(a, action, options), true);
  for (let i = 0; i < 1000; i++) assert.equal(await allowAction(a, action, options), false);
  assert.equal(await allowAction(b, action, options), true);
  assert.equal(await allowAction(b, action, options), true);
});
