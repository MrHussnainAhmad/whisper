const crypto = require('crypto');

const MESSAGE_TTL_MS = 90 * 1000;
const CAPTCHA_TTL_MS = 2 * 60 * 1000;
const MAX_GROUP_USERS = 500;
const MAX_GROUP_MESSAGES = 300;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const MESSAGE_MAX_CHARS = 1000;

const participants = new Map();
const usernames = new Map();
const messages = [];
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
  const cutoff = now();
  while (messages.length && messages[0].expiresAt <= cutoff) messages.shift();
  while (messages.length > MAX_GROUP_MESSAGES) messages.shift();
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
  messages.length = 0;
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
  const left = crypto.randomInt(2, 10);
  const right = crypto.randomInt(2, 10);
  const id = crypto.randomUUID();
  challenges.set(id, {
    answer: String(left + right),
    expiresAt: now() + CAPTCHA_TTL_MS,
  });
  return { id, question: `${left} + ${right}` };
}

function consumeCaptcha(id, answer) {
  pruneChallenges();
  if (typeof id !== 'string' || typeof answer !== 'string') return false;
  const challenge = challenges.get(id);
  if (!challenge) return false;
  challenges.delete(id);
  return challenge.answer === answer.trim();
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

function getGroupStatus() {
  return { activeUsers: participants.size, isActive: groupActive };
}

function setGroupStatusListener(listener) {
  groupStatusListener = typeof listener === 'function' ? listener : null;
}

function getRecentMessages() {
  pruneMessages();
  return messages
    .filter((message) => !message.private)
    .map((message) => ({ ...message }));
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
  if (!message.private) messages.push(message);
  pruneMessages();
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
  getGroupStatus,
  setGroupStatusListener,
  getRecentMessages,
  addMessage,
  MESSAGE_TTL_MS,
};
