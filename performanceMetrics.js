const { performance } = require('node:perf_hooks');
const { diagnostics } = require('./phase3Config');
const names = new Set(['forwardMs', 'queueMs', 'recipientAckMs', 'contention', 'pendingBytes']);
const counters = new Map();
function record(name, value) {
  if (!diagnostics || !names.has(name) || !Number.isFinite(value) || value < 0) return;
  const c = counters.get(name) || { count: 0, sum: 0, max: 0 };
  c.count++; c.sum += value; c.max = Math.max(c.max, value); counters.set(name, c);
}
function snapshot() {
  if (!diagnostics) return { enabled: false };
  return { enabled: true, metrics: Object.fromEntries([...counters].map(([k,v])=>[k,{...v}])), memory: process.memoryUsage() };
}
module.exports = { record, snapshot, now: () => performance.now() };
