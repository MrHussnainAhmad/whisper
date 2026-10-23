// Room-owned counters disappear on teardown. Global state has three fixed keys.
const { getEstablishedRoomCount } = require('./matchmaking');
const globals = new Map();
const roomCounters = new WeakMap();

function counter(store, key, now, windowMs) {
  const epoch = Math.floor(now / windowMs);
  let value = store.get(key);
  if (!value || value.epoch !== epoch) {
    value = { epoch, used: 0 };
    store.set(key, value);
  }
  return value;
}

function allowRoomResource(room, resource, globalLimit, windowMs, cost, roomCeiling) {
  if (!['events', 'messages', 'bytes'].includes(resource) ||
      !Number.isSafeInteger(cost) || cost < 1) return false;
  let store = roomCounters.get(room);
  if (!store) { store = new Map(); roomCounters.set(room, store); }
  const now = Date.now();
  const local = counter(store, resource, now, windowMs);
  const globalWindow = resource === 'bytes' ? 1000 : windowMs;
  const globalBudget = globalLimit * globalWindow / windowMs;
  const global = counter(globals, resource, now, globalWindow);
  // Even the only room cannot consume the entire allowance. Idle rooms retain
  // their share, so busy peers cannot borrow capacity from quiet conversations.
  const share = Math.min(roomCeiling, Math.floor(globalLimit / Math.max(2, getEstablishedRoomCount())));
  if (local.used + cost > share || global.used + cost > globalBudget) return false;
  local.used += cost;
  global.used += cost;
  return true;
}

module.exports = { allowRoomResource };
