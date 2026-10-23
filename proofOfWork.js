const crypto = require('node:crypto');
const ACTIONS = new Set(['find-random', 'create-invite']);
function powConfig(env = process.env) {
  if (![undefined, '0', '1'].includes(env.ONION_APP_POW_ENABLED)) throw new Error('Invalid ONION_APP_POW_ENABLED');
  const difficulty = Number(env.ONION_APP_POW_BITS ?? 16);
  if (!Number.isInteger(difficulty) || difficulty < 8 || difficulty > 22) throw new Error('Invalid ONION_APP_POW_BITS');
  return { enabled: env.ONION_APP_POW_ENABLED === '1', difficulty };
}
function digest(challenge, solution) {
  return crypto.createHash('sha256').update(`whisper-pow-v1|${challenge.id}|${challenge.nonce}|${challenge.action}|${solution}`).digest();
}
function validWork(challenge, solution) {
  if (typeof solution !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(solution)) return false;
  const hash = digest(challenge, solution);
  const bytes = Math.floor(challenge.difficulty / 8), bits = challenge.difficulty % 8;
  for (let i = 0; i < bytes; i++) if (hash[i] !== 0) return false;
  return !bits || (hash[bytes] >>> (8 - bits)) === 0;
}
function createProofOfWork({ difficulty = 16, maxEntries = 1024, challengeTtl = 30000, ticketTtl = 15000 } = {}) {
  const challenges = new Map(), owners = new Map(), tickets = new Map();
  function remove(id) {
    const c = challenges.get(id);
    if (c) { challenges.delete(id); owners.delete(`${c.owner}:${c.action}`); }
  }
  function prune() {
    const now = Date.now();
    for (const [id, c] of challenges) if (c.expiresAt <= now) remove(id);
    for (const [id, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(id);
  }
  const timer = setInterval(prune, 5000); timer.unref();
  return {
    issue(owner, action) {
      if (!ACTIONS.has(action) || !owner) return null;
      prune();
      const previous = owners.get(`${owner}:${action}`);
      if (previous) remove(previous);
      if (challenges.size + tickets.size >= maxEntries) return null;
      const c = { id: crypto.randomBytes(24).toString('hex'), nonce: crypto.randomBytes(32).toString('hex'),
        action, difficulty, expiresAt: Date.now() + challengeTtl, owner };
      challenges.set(c.id, c); owners.set(`${owner}:${action}`, c.id);
      const { owner: _owner, ...publicChallenge } = c;
      return { ...publicChallenge, version: 1, algorithm: 'sha256' };
    },
    solve(owner, id, solution) {
      if (typeof id !== 'string' || id.length !== 48) return null;
      const c = challenges.get(id);
      if (!c || c.owner !== owner) return null;
      remove(id); // Every verification attempt consumes the challenge.
      if (c.expiresAt <= Date.now() || !validWork(c, solution)) return null;
      const ticket = crypto.randomBytes(32).toString('hex');
      const entry = { action: c.action, expiresAt: Date.now() + ticketTtl };
      tickets.set(ticket, entry);
      return { ticket, ...entry };
    },
    consume(ticket, action) {
      if (typeof ticket !== 'string' || !/^[a-f0-9]{64}$/.test(ticket)) return false;
      const entry = tickets.get(ticket);
      if (!entry || entry.action !== action) return false;
      tickets.delete(ticket);
      return entry.expiresAt > Date.now();
    },
    forget(owner) { for (const action of ACTIONS) remove(owners.get(`${owner}:${action}`)); },
    stats() { prune(); return { challenges: challenges.size, tickets: tickets.size, owners: owners.size }; },
    close() { clearInterval(timer); challenges.clear(); owners.clear(); tickets.clear(); },
  };
}
const config = powConfig();
const proofOfWork = config.enabled ? createProofOfWork(config) : null;
module.exports = { powConfig, createProofOfWork, validWork, proofOfWork };
