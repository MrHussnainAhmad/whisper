const counters = new Map();
let reportTimer = null;

function recordSecurityEvent(name, amount = 1) {
  if (typeof name !== 'string' || !/^[a-z0-9-]{1,48}$/.test(name)) return;
  if (!Number.isSafeInteger(amount) || amount < 1) return;
  counters.set(name, (counters.get(name) || 0) + amount);
}

function takeSecuritySnapshot() {
  const snapshot = Object.fromEntries([...counters.entries()].sort());
  counters.clear();
  return snapshot;
}

function startSecurityMonitoring() {
  if (reportTimer) return false;
  reportTimer = setInterval(() => {
    const snapshot = takeSecuritySnapshot();
    if (Object.keys(snapshot).length) {
      console.warn('Aggregate security events:', JSON.stringify(snapshot));
    }
  }, 5 * 60 * 1000);
  reportTimer.unref();
  return true;
}

function stopSecurityMonitoring() {
  if (!reportTimer) return;
  clearInterval(reportTimer);
  reportTimer = null;
}

module.exports = {
  recordSecurityEvent,
  takeSecuritySnapshot,
  startSecurityMonitoring,
  stopSecurityMonitoring,
};
