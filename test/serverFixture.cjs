const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function startServer(overrides = {}) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'development', BIND_HOST: '127.0.0.1', PORT: String(port),
      TRUST_PROXY: '0', CORS_ORIGIN: '', ALLOW_UNVERIFIED_CHATS: 'false', ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-2000); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Server startup timed out')), 15000);
      const onExit = (code) => finish(new Error(`Server exited (${code}): ${stderr}`));
      const onData = (data) => { if (data.toString().includes('running on port')) finish(); };
      function finish(error) {
        clearTimeout(timer);
        child.off('exit', onExit); child.off('error', finish); child.stdout.off('data', onData);
        if (error) reject(error); else resolve();
      }
      child.once('exit', onExit); child.once('error', finish); child.stdout.on('data', onData);
    });
  } catch (error) { child.kill(); throw error; }
  return { url: `http://127.0.0.1:${port}`, child, stop: () => child.kill() };
}
module.exports = { startServer };
