const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { before, after, test } = require('node:test');
const { io } = require('socket.io-client');

const { isValidMessageId, isValidPublicKey, isValidBase64 } = require('../validation');
const { isValidInviteLocator } = require('../inviteRateLimiter');
const { createInvite, getInvite, consumeInvite } = require('../invites');
const { normalizeSource } = require('../abuseLimiter');
const { createOriginPolicy } = require('../corsPolicy');
const { recordSecurityEvent, takeSecuritySnapshot } = require('../securityMonitor');
const { addSession, removeSession } = require('../sessions');
const { _setRoom, getPeerSocketId, destroyRoom } = require('../matchmaking');

let serverProcess;
let serverUrl;

function once(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function connectClient() {
  const socket = io(serverUrl, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  await once(socket, 'joined');
  return socket;
}

function emitAck(socket, event, data, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeoutMs);
    const ack = (response) => {
      clearTimeout(timer);
      resolve(response);
    };
    if (data === undefined) socket.emit(event, ack);
    else socket.emit(event, data, ack);
  });
}

function solveCaptcha(captcha) {
  const match = String(captcha?.question || '').match(/^(\d+) \+ (\d+)$/);
  if (!match) throw new Error('Unexpected captcha format');
  return String(Number(match[1]) + Number(match[2]));
}

function solveProofOfWork(captcha) {
  for (let solution = 0; solution <= 1_000_000; solution += 1) {
    const digest = crypto.createHash('sha512')
      .update(`${captcha.id}|${captcha.powNonce}|${solution}`)
      .digest();
    const bits = captcha.powDifficultyBits;
    const fullBytes = Math.floor(bits / 8);
    let valid = true;
    for (let index = 0; index < fullBytes; index += 1) {
      if (digest[index] !== 0) valid = false;
    }
    const remainder = bits % 8;
    if (valid && (remainder === 0 ||
        (digest[fullBytes] & (0xff << (8 - remainder))) === 0)) return solution;
  }
  throw new Error('Could not solve proof of work');
}

before(async () => {
  const port = await getFreePort();
  serverUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      TRUST_PROXY: '0',
      REDIS_URL: '',
      VALKEY_URL: '',
      GROUP_POW_DIFFICULTY_BITS: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out')), 5000);
    serverProcess.once('exit', (code) => reject(new Error(`Server exited with ${code}`)));
    serverProcess.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('running on port')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
});

after(() => {
  serverProcess?.kill();
});

test('strict key and ciphertext validation rejects malformed inputs', () => {
  assert.equal(isValidPublicKey(Buffer.alloc(32, 7).toString('base64')), true);
  assert.equal(isValidPublicKey('not-a-key'), false);
  assert.equal(isValidBase64('AAAA', 16), true);
  assert.equal(isValidBase64('AAAA!', 16), false);
  assert.equal(isValidBase64('A'.repeat(20), 16), false);
});

test('message identifiers and aggregate monitoring reject identifying fields', () => {
  assert.equal(isValidMessageId('20000000-0000-4000-8000-000000000002'), true);
  assert.equal(isValidMessageId('not-a-message-id'), false);
  recordSecurityEvent('invalid-encrypted-payload');
  recordSecurityEvent('contains_private_value@example.com');
  assert.deepEqual(takeSecuritySnapshot(), { 'invalid-encrypted-payload': 1 });
});

test('invite locators are single-consumer while the authentication secret stays client-side', async () => {
  const sessionId = '10000000-0000-4000-8000-000000000001';
  const locator = await createInvite(sessionId, 'socket-unit');
  assert.equal(isValidInviteLocator(locator), true);
  assert.match(locator, /^TALK-(?:[2-9A-HJ-NP-Z]{4}-){3}[2-9A-HJ-NP-Z]{4}$/);
  assert.equal((await getInvite(locator)).sessionId, sessionId);
  assert.equal((await consumeInvite(locator, sessionId)).sessionId, sessionId);
  assert.equal(await consumeInvite(locator, sessionId), null);
});

test('IPv6 sources aggregate by /64', () => {
  assert.equal(normalizeSource('2001:db8:abcd:12::1'), normalizeSource('2001:db8:abcd:12::ffff'));
  assert.notEqual(normalizeSource('2001:db8:abcd:12::1'), normalizeSource('2001:db8:abcd:13::1'));
});

test('spoofed forwarded protocol is ignored when no proxy is trusted', () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldTrustProxy = process.env.TRUST_PROXY;
  process.env.NODE_ENV = 'production';
  process.env.TRUST_PROXY = '0';
  delete require.cache[require.resolve('../security')];
  const { isSecureRequest } = require('../security');
  assert.equal(isSecureRequest({
    secure: false,
    socket: { encrypted: false },
    headers: { 'x-forwarded-proto': 'https' },
  }), false);
  if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = oldNodeEnv;
  if (oldTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = oldTrustProxy;
  delete require.cache[require.resolve('../security')];
});

test('production browser origins must use an explicit allow-list', () => {
  assert.throws(() => createOriginPolicy('*', 'production'), /explicit/i);
  const policy = createOriginPolicy('https://whisperchatapp.duckdns.org', 'production');
  assert.equal(policy.allows(undefined), true);
  assert.equal(policy.allows('https://whisperchatapp.duckdns.org'), true);
  assert.equal(policy.allows('https://evil.example'), false);
});

test('self-redemption does not destroy an invite and control fields are allow-listed', async () => {
  const inviter = await connectClient();
  const joiner = await connectClient();
  try {
    const createResult = await new Promise((resolve) => {
      inviter.emit('create-invite', { locator: 'TALK-AAAA-AAAA-AAAA-AAAA' }, resolve);
    });
    assert.equal(createResult.ok, true);
    const locator = createResult.locator;
    assert.equal(isValidInviteLocator(locator), true);
    assert.notEqual(locator, 'TALK-AAAA-AAAA-AAAA-AAAA');

    const selfErrorPromise = once(inviter, 'error');
    inviter.emit('join-invite', { locator });
    assert.match((await selfErrorPromise).message, /own invite/);

    const inviterMatched = once(inviter, 'matched');
    const joinerMatched = once(joiner, 'matched');
    joiner.emit('join-invite', { locator });
    const [firstMatch, secondMatch] = await Promise.all([inviterMatched, joinerMatched]);
    assert.equal(firstMatch.roomId, secondMatch.roomId);

    const verificationError = once(joiner, 'error');
    joiner.emit('send-encrypted', { encrypted: 'AAAA' });
    assert.match((await verificationError).message, /Verify chat security/);

    const alertPromise = once(joiner, 'peer-security-alert');
    inviter.emit('security-alert', { type: 'screenshot', injected: 'removed' });
    assert.deepEqual(await alertPromise, { type: 'screenshot', source: 'peer-claim' });

    const joinerSeesKey = once(joiner, 'peer-key');
    inviter.emit('key-exchange', { publicKey: Buffer.alloc(32, 9).toString('base64') });
    await joinerSeesKey;

    const incomplete = await new Promise((resolve) => inviter.emit('verify-chat', resolve));
    assert.equal(incomplete.ok, false);
    assert.match(incomplete.error || '', /Peer key/i);

    const inviterSeesKey = once(inviter, 'peer-key');
    joiner.emit('key-exchange', { publicKey: Buffer.alloc(32, 3).toString('base64') });
    await inviterSeesKey;

    const joinerSeesConfirmation = once(joiner, 'peer-key-confirm');
    inviter.emit('key-confirm', { proof: 'AAAA' });
    assert.deepEqual(await joinerSeesConfirmation, { proof: 'AAAA' });

    const inviterSeesConfirmation = once(inviter, 'peer-key-confirm');
    joiner.emit('key-confirm', { proof: 'BBBB' });
    assert.deepEqual(await inviterSeesConfirmation, { proof: 'BBBB' });

    const verified = await new Promise((resolve) => inviter.emit('verify-chat', resolve));
    assert.deepEqual(verified, { ok: true });

    const messageId = '20000000-0000-4000-8000-000000000002';
    const relayedMessage = once(joiner, 'receive-encrypted');
    const firstRelay = await emitAck(inviter, 'send-encrypted', {
      messageId,
      encrypted: 'AAAA',
    });
    assert.deepEqual(firstRelay, { ok: true, messageId, duplicate: false });
    assert.deepEqual(await relayedMessage, { encrypted: 'AAAA', messageId });

    const duplicateRelay = await emitAck(inviter, 'send-encrypted', {
      messageId,
      encrypted: 'AAAA',
    });
    assert.deepEqual(duplicateRelay, { ok: true, messageId, duplicate: true });

    const typingPromise = once(joiner, 'peer-typing');
    inviter.emit('typing', { active: true, injected: 'removed' });
    assert.deepEqual(await typingPromise, { active: true });
  } finally {
    inviter.disconnect();
    joiner.disconnect();
  }
});

test('HTTP surface is bodyless, bounded, and sends restrictive headers', async () => {
  const response = await fetch(`${serverUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');

  const missing = await fetch(`${serverUrl}/not-found`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oversizedRoutesAreNotAccepted: true }),
  });
  assert.equal(missing.status, 404);
});

test('room routing never falls back to a stale socket ID', async () => {
  const firstId = '20000000-0000-4000-8000-000000000001';
  const secondId = '20000000-0000-4000-8000-000000000002';
  const roomId = '30000000-0000-4000-8000-000000000001';
  await addSession(firstId, 'socket-first');
  await addSession(secondId, 'socket-second');
  try {
    assert.equal(await _setRoom(roomId, {
      session1: { sessionId: firstId, socketId: 'socket-first' },
      session2: { sessionId: secondId, socketId: 'socket-second' },
    }), true);
    assert.equal(await getPeerSocketId(roomId, firstId), 'socket-second');
    await removeSession(secondId);
    assert.equal(await getPeerSocketId(roomId, firstId), null);
  } finally {
    await destroyRoom(roomId);
    await removeSession(firstId);
    await removeSession(secondId);
  }
});

test('random matchmaking always acknowledges the resulting UI state', async () => {
  const client = await connectClient();
  try {
    const result = await emitAck(client, 'find-random', {});
    assert.equal(result.ok, true);
    assert.equal(result.status, 'waiting');
  } finally {
    client.emit('cancel-search');
    client.disconnect();
  }
});

test('global group chat uses temporary unique usernames and retains no history', async () => {
  const first = await connectClient();
  const second = await connectClient();
  const third = await connectClient();
  try {
    const firstCaptcha = (await emitAck(first, 'group-captcha')).captcha;
    assert.equal(firstCaptcha.refreshEveryMs, 15_000);
    assert.equal(firstCaptcha.questions.length, 8);
    const firstJoin = await emitAck(first, 'join-group', {
      username: 'Alice',
      captchaId: firstCaptcha.id,
      captchaAnswer: solveCaptcha(firstCaptcha),
      powSolution: solveProofOfWork(firstCaptcha),
    });
    assert.equal(firstJoin.ok, true);
    assert.equal(firstJoin.username, 'Alice');
    assert.equal(firstJoin.messageTtlMs, 90_000);
    assert.deepEqual(firstJoin.users, ['Alice']);

    const duplicateCaptcha = (await emitAck(second, 'group-captcha')).captcha;
    const duplicateJoin = await emitAck(second, 'join-group', {
      username: 'alice',
      captchaId: duplicateCaptcha.id,
      captchaAnswer: solveCaptcha(duplicateCaptcha),
      powSolution: solveProofOfWork(duplicateCaptcha),
    });
    assert.equal(duplicateJoin.ok, false);
    assert.match(duplicateJoin.error, /already/i);

    const secondCaptcha = (await emitAck(second, 'group-captcha')).captcha;
    const secondJoin = await emitAck(second, 'join-group', {
      username: 'Bob',
      captchaId: secondCaptcha.id,
      captchaIndex: 1,
      captchaAnswer: solveCaptcha({ question: secondCaptcha.questions[1] }),
      powSolution: solveProofOfWork(secondCaptcha),
    });
    assert.equal(secondJoin.ok, true);
    assert.equal(secondJoin.activeUsers, 2);
    assert.deepEqual(secondJoin.users, ['Alice', 'Bob']);

    const groupStatus = await emitAck(first, 'group-status', {});
    assert.deepEqual(groupStatus, { ok: true, activeUsers: 2, isActive: true });

    const sent = await emitAck(first, 'group-message', { text: 'hello @Bob' });
    assert.equal(sent.ok, true);
    assert.equal(sent.message.username, 'Alice');
    assert.deepEqual(sent.message.mentions, ['Bob']);
    assert.equal(sent.message.private, true);

    await emitAck(first, 'leave-group');
    const thirdCaptcha = (await emitAck(third, 'group-captcha')).captcha;
    const thirdJoin = await emitAck(third, 'join-group', {
      username: 'Alice',
      captchaId: thirdCaptcha.id,
      captchaAnswer: solveCaptcha(thirdCaptcha),
      powSolution: solveProofOfWork(thirdCaptcha),
    });
    assert.equal(thirdJoin.ok, true);
    assert.equal(thirdJoin.username, 'Alice');
    assert.equal(thirdJoin.messages.some((message) => message.text === 'hello @Bob'), false);
  } finally {
    first.emit('leave-group');
    second.emit('leave-group');
    third.emit('leave-group');
    first.disconnect();
    second.disconnect();
    third.disconnect();
  }
});
