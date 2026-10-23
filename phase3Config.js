function flag(name) {
  const v = process.env[name];
  if (v !== undefined && v !== '0' && v !== '1') throw new Error(`${name} must be 0 or 1`);
  return v === '1';
}
const graceMs = Number(process.env.RESUME_GRACE_MS || 90000);
if (!Number.isInteger(graceMs) || graceMs < 60000 || graceMs > 90000) throw new Error('RESUME_GRACE_MS must be 60000 through 90000');
module.exports = { resume: flag('RESUME_ENABLED'), binary: flag('BINARY_RELAY_ENABLED'), diagnostics: flag('PERF_DIAGNOSTICS'), graceMs };
