const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createApp } = require('../server/app');

test('peer refresh replaces cached platform metadata and preserves it after restart', async () => {
  const output = path.resolve(__dirname, '../test-output');
  await fs.mkdir(output, { recursive: true });
  const directory = await fs.mkdtemp(path.join(output, 'landrop-platform-'));
  const info = { protocol: 'landrop-v1', id: crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex'), name: 'Android phone', platform: 'win32', enabled: true };
  const peer = http.createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(info)); });
  await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve));
  info.port = peer.address().port;
  let app;
  try {
    app = await createApp({ port: 0, dataDir: directory });
    const call = (route, body) => fetch(`http://127.0.0.1:${app.port}${route}`, { method: 'POST', headers: { 'X-App-Token': app.state().uiToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    assert.equal((await call('/api/peers', { address: `127.0.0.1:${info.port}` })).status, 200);
    assert.equal(app.state().peers[0].platform, 'win32');
    info.platform = 'android';
    assert.equal((await call('/api/scan')).status, 200);
    assert.equal(app.state().peers[0].platform, 'android');
    assert.equal(app.state().peers[0].online, true);
    await app.close();
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
    assert.equal(saved.peers.length, 1, 'Refreshed peer must be written to disk');
    assert.equal(saved.peers[0].platform, 'android');
    assert.equal(saved.peers[0].port, info.port);
    assert.equal(saved.peers[0].address, '127.0.0.1');
    app = await createApp({ port: 0, dataDir: directory });
    assert.equal(app.state().peers[0].platform, 'android');
    delete info.platform;
    assert.equal((await call('/api/scan')).status, 200);
    assert.equal(app.state().peers[0].platform, 'unknown');
  } finally {
    await app?.close();
    await new Promise(resolve => peer.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)), output);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
