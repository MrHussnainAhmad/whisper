const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { acceptProxySocket } = require('./torProxy');

function integer(env, name, fallback, max = 100000) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
function onionConfig(env = process.env) {
  if (!['0', '1', undefined].includes(env.ONION_ENABLED)) throw new Error('ONION_ENABLED must be 0 or 1');
  const enabled = env.ONION_ENABLED === '1';
  return {
    enabled, socketPath: env.ONION_SOCKET_PATH || '/run/whisper-onion/relay.sock',
    maxStreams: integer(env, 'ONION_MAX_STREAMS', 1000),
    maxPending: integer(env, 'ONION_MAX_PENDING', 64),
    perCircuit: integer(env, 'ONION_STREAMS_PER_CIRCUIT', 8),
    headerTimeout: integer(env, 'ONION_PROXY_TIMEOUT_MS', 2000, 10000),
  };
}

function createOnionBoundary(httpServer, config) {
  const sockets = new Set(), circuits = new Map();
  let pending = 0, ready = false;
  const server = net.createServer(socket => {
    if (!ready || sockets.size >= config.maxStreams || pending >= config.maxPending) { socket.destroy(); return; }
    sockets.add(socket); pending++;
    let key, parsed = false;
    socket.once('close', () => {
      sockets.delete(socket);
      if (!parsed) pending--;
      if (key) {
        const count = circuits.get(key) - 1;
        if (count) circuits.set(key, count); else circuits.delete(key);
      }
    });
    acceptProxySocket(socket, {
      timeoutMs: config.headerTimeout,
      admit: candidate => {
        if ((circuits.get(candidate) || 0) >= config.perCircuit) return false;
        key = candidate; circuits.set(key, (circuits.get(key) || 0) + 1);
        parsed = true; pending--; return true;
      },
      ready: accepted => {
        // Also bound a peer that sends PROXY but never completes HTTP headers.
        accepted.setTimeout(15000, () => accepted.destroy());
        httpServer.emit('connection', accepted);
      },
    });
  });
  // Forward the listener lifecycle so Node starts its absolute HTTP header/body
  // timeout checker even though the HTTP parser itself never binds a port.
  server.once('listening', () => httpServer.emit('listening'));
  return {
    server,
    activate() { ready = true; },
    stats() { return { streams: sockets.size, pending, circuits: circuits.size }; },
    async close() {
      ready = false;
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      httpServer.close();
    },
  };
}

async function listenOnion(boundary, config) {
  if (process.platform === 'win32') throw new Error('Onion listener requires Unix socket permissions; use Linux');
  const target = config.socketPath;
  if (!path.isAbsolute(target) || target.includes('\0') || Buffer.byteLength(target) > 100) throw new Error('Invalid ONION_SOCKET_PATH');
  const directory = path.dirname(target);
  // Reject symlink components and group-writable directories: Tor may connect
  // but must not be able to replace the socket or its containing directory.
  let component = path.parse(directory).root;
  for (const name of directory.slice(component.length).split(path.sep).filter(Boolean)) {
    component = path.join(component, name);
    const entry = fs.lstatSync(component);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o022)) throw new Error('Unsafe onion socket directory');
  }
  const dir = fs.statSync(directory);
  if (dir.uid !== process.getuid() || (dir.mode & 0o007)) throw new Error('Onion socket directory must be backend-owned and private');
  // Never unlink an existing path automatically (could be another live service).
  if (fs.existsSync(target)) throw new Error('Onion socket path already exists');
  await new Promise((resolve, reject) => {
    boundary.server.once('error', reject);
    boundary.server.listen(target, () => { boundary.server.off('error', reject); resolve(); });
  });
  try {
    fs.chownSync(target, process.getuid(), dir.gid);
    fs.chmodSync(target, 0o660);
    boundary.activate();
  } catch (error) { await boundary.close(); throw error; }
}
module.exports = { onionConfig, createOnionBoundary, listenOnion };
