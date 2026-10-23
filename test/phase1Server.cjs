// Test-only loopback surrogate for the Unix/Tor hop. Never used by server.js.
const { server, io, onionHttp } = require('../server');
const { createOnionBoundary, onionConfig } = require('../onionListener');
const boundary = createOnionBoundary(onionHttp.server, onionConfig());
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  boundary.activate();
  await new Promise(resolve => boundary.server.listen(0, '127.0.0.1', resolve));
  process.send({ publicPort: server.address().port, onionPort: boundary.server.address().port });
})();
process.on('message', async message => {
  if (message === 'stats') process.send({ stats: boundary.stats() });
  if (message === 'stop') {
    await boundary.close(); await io.close();
    require('../proofOfWork').proofOfWork?.close();
    process.exit(0);
  }
});
