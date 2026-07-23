const crypto = require('crypto');

const MESSAGE_TTL_MS = 90 * 1000;
const CAPTCHA_TTL_MS = 2 * 60 * 1000;
const CAPTCHA_REFRESH_MS = 15 * 1000;
const CAPTCHA_QUESTION_COUNT = CAPTCHA_TTL_MS / CAPTCHA_REFRESH_MS;
const POW_DIFFICULTY_BITS = (() => {
  const value = Number(process.env.GROUP_POW_DIFFICULTY_BITS || 12);
  if (!Number.isInteger(value) || value < 4 || value > 20) {
    throw new Error('GROUP_POW_DIFFICULTY_BITS must be an integer from 4 to 20');
  }
  return value;
})();
const MAX_GROUP_USERS = 500;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const MESSAGE_MAX_CHARS = 1000;

const participants = new Map();
const usernames = new Map();
const challenges = new Map();
let idleShutdownTimer = null;
let groupActive = false;
let groupStatusListener = null;

function now() {
  return Date.now();
}

function normalizeUsername(username) {
  return typeof username === 'string' ? username.trim() : '';
}

function usernameKey(username) {
  return username.toLowerCase();
}

function pruneMessages() {
  // Group messages are live relay-only and are never retained by the backend.
}

function pruneChallenges() {
  const cutoff = now();
  for (const [id, challenge] of challenges) {
    if (challenge.expiresAt <= cutoff) challenges.delete(id);
  }
}

function cancelIdleShutdown() {
  if (!idleShutdownTimer) return;
  clearTimeout(idleShutdownTimer);
  idleShutdownTimer = null;
}

function destroyIdleGroupState() {
  idleShutdownTimer = null;
  if (participants.size > 0) return;
  groupActive = false;
  usernames.clear();
  challenges.clear();
  groupStatusListener?.(getGroupStatus());
}

function scheduleIdleShutdown() {
  if (participants.size > 0 || idleShutdownTimer) return;
  idleShutdownTimer = setTimeout(destroyIdleGroupState, 10 * 1000);
  idleShutdownTimer.unref();
}

function createCaptcha() {
  cancelIdleShutdown();
  pruneChallenges();
  const id = crypto.randomUUID();
  const powNonce = crypto.randomBytes(16).toString('hex');
  const questions = Array.from({ length: CAPTCHA_QUESTION_COUNT }, () => {
    const left = crypto.randomInt(2, 10);
    const right = crypto.randomInt(2, 10);
    return { question: `${left} + ${right}`, answer: String(left + right) };
  });
  challenges.set(id, {
    answers: questions.map((entry) => entry.answer),
    powNonce,
    powDifficultyBits: POW_DIFFICULTY_BITS,
    expiresAt: now() + CAPTCHA_TTL_MS,
  });
  return {
    id,
    question: questions[0].question,
    questions: questions.map((entry) => entry.question),
    refreshEveryMs: CAPTCHA_REFRESH_MS,
    powNonce,
    powDifficultyBits: POW_DIFFICULTY_BITS,
  };
}

function hasLeadingZeroBits(buffer, bits) {
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (buffer[index] !== 0) return false;
  }
  const remainder = bits % 8;
  return remainder === 0 || (buffer[fullBytes] & (0xff << (8 - remainder))) === 0;
}

function consumeCaptcha(id, answer, questionIndex = 0, powSolution) {
  pruneChallenges();
  if (typeof id !== 'string' || typeof answer !== 'string') return false;
  const challenge = challenges.get(id);
  if (!challenge) return false;
  const index = Number(questionIndex);
  const solution = Number(powSolution);
  if (!Number.isInteger(index) || index < 0 || index >= challenge.answers.length) return false;
  if (!Number.isSafeInteger(solution) || solution < 0 || solution > 1_000_000) return false;
  const proof = crypto.createHash('sha512')
    .update(`${id}|${challenge.powNonce}|${solution}`)
    .digest();
  if (!hasLeadingZeroBits(proof, challenge.powDifficultyBits)) return false;
  challenges.delete(id);
  return challenge.answers[index] === answer.trim();
}

function validateUsername(username) {
  const value = normalizeUsername(username);
  if (!USERNAME_RE.test(value)) {
    return { ok: false, error: 'Use 3-20 letters, numbers, or underscores.' };
  }
  if (usernames.has(usernameKey(value))) {
    return { ok: false, error: 'That username is already in the group.' };
  }
  return { ok: true, username: value };
}

function joinGroup(sessionId, socketId, username) {
  cancelIdleShutdown();
  pruneMessages();
  if (!sessionId || !socketId) return { ok: false, error: 'Session not found' };
  if (participants.size >= MAX_GROUP_USERS) return { ok: false, error: 'Group is full. Try again later.' };

  leaveGroup(sessionId);
  const result = validateUsername(username);
  if (!result.ok) return result;

  groupActive = true;
  participants.set(sessionId, {
    sessionId,
    socketId,
    username: result.username,
    joinedAt: now(),
  });
  usernames.set(usernameKey(result.username), sessionId);

  return {
    ok: true,
    username: result.username,
    activeUsers: participants.size,
    messages: getRecentMessages(),
  };
}

function leaveGroup(sessionId) {
  const participant = participants.get(sessionId);
  if (!participant) return null;
  participants.delete(sessionId);
  usernames.delete(usernameKey(participant.username));
  scheduleIdleShutdown();
  return participant;
}

function getParticipant(sessionId) {
  return participants.get(sessionId) || null;
}

function getActiveCount() {
  return participants.size;
}

function getCurrentUsers() {
  return [...participants.values()]
    .map((participant) => participant.username)
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}

function getGroupStatus() {
  return { activeUsers: participants.size, isActive: groupActive };
}

function setGroupStatusListener(listener) {
  groupStatusListener = typeof listener === 'function' ? listener : null;
}

function getRecentMessages() {
  return [];
}

function extractMentions(text) {
  const found = new Set();
  const re = /(^|[^\w])@([A-Za-z0-9_]{3,20})\b/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const name = match[2];
    if (usernames.has(usernameKey(name))) found.add(name);
  }
  return [...found].slice(0, 10);
}

function getMentionRecipients(mentions) {
  const recipients = [];
  for (const mention of mentions) {
    const sessionId = usernames.get(usernameKey(mention));
    const participant = sessionId ? participants.get(sessionId) : null;
    if (participant?.socketId) recipients.push(participant);
  }
  return recipients;
}

function addMessage(sessionId, text) {
  pruneMessages();
  const participant = getParticipant(sessionId);
  if (!participant) return { ok: false, error: 'Join group chat first.' };

  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return { ok: false, error: 'Message is empty.' };
  if (value.length > MESSAGE_MAX_CHARS) return { ok: false, error: 'Message is too long.' };

  const createdAt = now();
  const mentions = extractMentions(value);
  const mentionRecipients = getMentionRecipients(mentions);
  const message = {
    id: crypto.randomUUID(),
    username: participant.username,
    text: value,
    mentions,
    private: mentionRecipients.length > 0,
    createdAt,
    expiresAt: createdAt + MESSAGE_TTL_MS,
  };
  return {
    ok: true,
    message: { ...message },
    targetSocketIds: message.private
      ? [...new Set([participant.socketId, ...mentionRecipients.map((entry) => entry.socketId)])]
      : null,
  };
}

const cleanupTimer = setInterval(() => {
  pruneMessages();
  pruneChallenges();
  scheduleIdleShutdown();
}, 10 * 1000);
cleanupTimer.unref();

module.exports = {
  createCaptcha,
  consumeCaptcha,
  joinGroup,
  leaveGroup,
  getParticipant,
  getActiveCount,
  getCurrentUsers,
  getGroupStatus,
  setGroupStatusListener,
  getRecentMessages,
  addMessage,
  MESSAGE_TTL_MS,
};
