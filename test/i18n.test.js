const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../server/app');
const { en, translate, translateError, translateInterfaceName } = require('../public/i18n');

test('translations cover UI source text, preserve parameters, and display legacy errors', async () => {
  const html = await fs.readFile(path.join(__dirname, '..', 'public/index.html'), 'utf8');
  const texts = [...html.matchAll(/>([^<>]+)</g)].map(match => match[1].trim());
  const attributes = [...html.matchAll(/(?:title|placeholder|aria-label|alt)="([^"]+)"/g)].map(match => match[1]);
  for (const text of [...texts, ...attributes]) {
    if (/[\u4e00-\u9fff]/.test(text) && text !== '简体中文') assert.ok(Object.hasOwn(en, text), `Missing translation: ${text}`);
  }
  const app = await fs.readFile(path.join(__dirname, '..', 'public/app.js'), 'utf8');
  for (const [, key] of app.matchAll(/\bt\('([^']+)'/g)) assert.ok(Object.hasOwn(en, key), `Missing dynamic translation: ${key}`);
  assert.equal(translate('en', '移除 {name}', { name: '我的电脑 {count} <script>' }), 'Remove 我的电脑 {count} <script>');
  assert.equal(translate('zh-CN', '移除 {name}', { name: 'My PC' }), '移除 My PC');
  assert.equal(translate('en', 'Unexpected OS error'), 'Unexpected OS error');
  assert.equal(translateError('en', '应用退出，传输已中断'), 'The application exited and interrupted the transfer');
  assert.equal(translateError('en', '保存记录失败：ENOSPC'), 'Failed to save records: ENOSPC');
});

test('language settings persist across restart, reject invalid values, and leave data intact', async () => {
  const root = path.join(__dirname, '..', 'test-output');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'language-'));
  let app;
  const changes = [];
  try {
    app = await createApp({ port: 0, dataDir: directory, name: '原始名称', onLanguageChanged: value => changes.push(value) });
    const identity = app.state().self.id, folder = app.state().settings.receiveDir;
    const post = data => fetch(`http://127.0.0.1:${app.port}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': app.state().uiToken }, body: JSON.stringify(data)
    });
    assert.equal(app.state().settings.language, 'zh-CN');
    assert.equal((await post({ language: 'en' })).status, 200);
    assert.equal(app.state().settings.language, 'en');
    assert.equal(app.state().self.name, '原始名称');
    assert.equal(app.state().settings.receiveDir, folder);
    assert.deepEqual(changes, ['en']);
    assert.equal((await post({ language: 'unsupported', name: '不应保存', enabled: false })).status, 400);
    assert.equal(app.state().self.name, '原始名称');
    assert.equal(app.state().settings.enabled, true);
    await app.close();
    app = await createApp({ port: 0, dataDir: directory });
    assert.equal(app.state().settings.language, 'en');
    assert.equal(app.state().self.id, identity);
    assert.equal((await post({ name: '更名', enabled: false })).status, 200);
    assert.equal(app.state().settings.language, 'en');
    assert.equal((await post({ language: 'zh-CN' })).status, 200);
    assert.equal(app.state().settings.enabled, false);
    await app.close();
    app = await createApp({ port: 0, dataDir: directory });
    assert.equal(app.state().settings.language, 'zh-CN');
    const asset = await fetch(`http://127.0.0.1:${app.port}/i18n.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
  } finally { await app?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('standard network adapter names switch languages without changing custom names', () => {
  assert.equal(translateInterfaceName('en', '以太网'), 'Ethernet');
  assert.equal(translateInterfaceName('en', '以太网 2'), 'Ethernet 2');
  assert.equal(translateInterfaceName('zh-CN', 'Ethernet 2'), '以太网 2');
  assert.equal(translateInterfaceName('en', '本地连接'), 'Local Area Connection');
  assert.equal(translateInterfaceName('en', '无线网络连接 3'), 'Wireless Network Connection 3');
  assert.equal(translateInterfaceName('en', '蓝牙网络连接'), 'Bluetooth Network Connection');
  for (const name of ['Wi-Fi', 'vEthernet (WSL)', '办公网络', '以太网 办公', '以太网<script>']) {
    assert.equal(translateInterfaceName('en', name), name);
    assert.equal(translateInterfaceName('zh-CN', name), name);
  }
});

test('transfer rejection uses a stable code regardless of the peer error language', async () => {
  const root = path.join(__dirname, '..', 'test-output');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'reject-language-'));
  const identity = 'demo-peer', token = 'a'.repeat(64);
  let app, message = 'Request rejected by the receiver';
  const remote = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    req.resume();
    if (req.url === '/peer/info') res.end(JSON.stringify({ protocol: 'landrop-v1', id: identity, token, name: 'Demo peer', port: remote.address().port, enabled: true }));
    else { res.writeHead(403); res.end(JSON.stringify({ error: message, errorCode: 'TRANSFER_REJECTED' })); }
  });
  try {
    await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
    app = await createApp({ port: 0, dataDir: directory });
    const response = await fetch(`http://127.0.0.1:${app.port}/api/peers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': app.state().uiToken }, body: JSON.stringify({ address: `127.0.0.1:${remote.address().port}` })
    });
    assert.equal(response.status, 200);
    assert.equal((await app.sendText(identity, 'English error')).status, 'rejected');
    message = '接收端拒绝了请求';
    assert.equal((await app.sendText(identity, 'Chinese error')).status, 'rejected');
  } finally {
    await app?.close(); remote.closeAllConnections();
    await new Promise(resolve => remote.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
