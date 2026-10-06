// README screenshots use only fixed demonstration data, never local device state.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const version = require('../package.json').version;
const demo = {
  self: { id: 'demo-device', name: '示例电脑', platform: 'win32', port: 45878, addresses: ['示例地址'],
    interfaces: [{ name: 'Wi-Fi（示例）', address: '示例地址', virtual: false }, { name: '虚拟网卡（示例）', address: '示例虚拟地址', virtual: true }] },
  settings: { receiveDir: 'D:\\LanDrop\\Received', enabled: true, language: 'zh-CN' },
  peers: [
    { id: 'demo-phone', name: '示例安卓手机', platform: 'android', address: '示例手机地址', port: 45878, online: true, enabled: true },
    { id: 'demo-pc', name: '另一台示例电脑', platform: 'win32', address: '示例电脑地址', port: 45878, online: true, enabled: true }
  ], transfers: [], warning: '', uiToken: 'demo-preview'
};
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'application/javascript; charset=utf-8']],
  ['/i18n.js', ['i18n.js', 'application/javascript; charset=utf-8']],
  ['/community-links.js', ['community-links.js', 'application/javascript; charset=utf-8']],
  ['/community.js', ['community.js', 'application/javascript; charset=utf-8']],
  ['/logo.png', ['logo.png', 'image/png']],
  ['/mascot-received.png', ['mascot-received.png', 'image/png']],
  ['/mascot-sent.png', ['mascot-sent.png', 'image/png']],
  ['/mark.svg', ['mark.svg', 'image/svg+xml']]
]);

(async () => {
  const clients = new Set();
  const server = http.createServer(async (request, response) => {
    const route = new URL(request.url, 'http://localhost').pathname;
    if (route === '/api/state') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify(demo));
    }
    if (route === '/api/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      clients.add(response); response.once('close', () => clients.delete(response));
      return response.write(`data: ${JSON.stringify(demo)}\n\n`);
    }
    const asset = assets.get(route);
    if (!asset) { response.writeHead(404); return response.end(); }
    try {
      const contents = await fs.readFile(path.join(root, 'public', asset[0]));
      response.writeHead(200, { 'Content-Type': asset[1] });
      response.end(contents);
    } catch { response.writeHead(500); response.end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    await page.addInitScript(() => { window.desktop = { chooseFolder: async () => {}, openFolder: async () => '', copyText: async () => {}, openExternal: async () => {} }; });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('#device-name').filter({ hasText: demo.self.name }).waitFor();
    await page.evaluate(async () => Promise.all([...document.images].map(image => image.decode())));
    // Replace the static input example as well as all runtime addresses before
    // capture. Every image comes from this isolated fixture server.
    await page.locator('#peer-address').evaluate(node => { node.placeholder = '对方的示例地址:端口'; });
    assert.equal(await page.locator('#local-address').textContent(), '示例地址:45878');
    assert.equal(await page.locator('#receive-directory').textContent(), 'D:\\LanDrop\\Received');
    assert.equal(await page.locator('#self-name').textContent(), '示例电脑');
    const phone = page.locator('#nearby-devices [data-peer="demo-phone"]');
    assert.match(await phone.innerText(), /Android 手机/);
    assert.equal(await phone.locator('.peer-avatar use').getAttribute('href'), '#i-phone');
    assert.equal(await page.locator('#nearby-devices [data-peer="demo-pc"] .peer-avatar use').getAttribute('href'), '#i-monitor');
    async function capture(filename) {
      const content = await page.evaluate(() => document.body.innerText + [...document.querySelectorAll('input')].map(node => node.value + node.placeholder).join(' '));
      assert.doesNotMatch(content, /\b(?:\d{1,3}\.){3}\d{1,3}\b/, filename + ' must contain no numeric IPv4 address');
      assert.doesNotMatch(content, /Users[\\/]ASUS|DESKTOP-/, filename + ' must contain no machine identity');
      await page.screenshot({ path: path.join(root, 'docs', filename.replace('.png', `-${version}.png`)), fullPage: true });
    }
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await capture('preview.png');
    await page.locator('.nav-item[data-page="devices"]').click();
    assert.equal(await page.locator('.local-interface').count(), 2);
    assert.equal(await page.locator('#all-devices [data-peer="demo-phone"] .peer-avatar use').getAttribute('href'), '#i-phone');
    await capture('connections.png');
    await page.locator('.nav-item[data-page="home"]').click();
    const createdAt = Date.UTC(2026, 0, 1, 8, 0);
    demo.transfers = ['incoming', 'outgoing'].map(direction => ({
      id: `demo-${direction}`, kind: 'file', direction, status: 'completed',
      name: direction === 'incoming' ? '示例图片.png' : '示例文档.pdf', peerName: direction === 'incoming' ? '示例安卓手机' : '另一台示例电脑',
      size: 1048576, createdAt, updatedAt: createdAt, progress: 100, bytes: 1048576
    }));
    for (const client of clients) client.write(`data: ${JSON.stringify(demo)}\n\n`);
    await page.locator('[data-success-direction="incoming"]').waitFor();
    await page.locator('[data-success-direction="outgoing"]').waitFor();
    await page.evaluate(async () => Promise.all([...document.images].map(image => image.decode())));
    await page.locator('.success-notice').evaluateAll(elements => Promise.all(elements.flatMap(element => element.getAnimations().map(animation => animation.finished.catch(() => {})))));
    await capture('transfer-success.png');
    for (const direction of ['incoming', 'outgoing']) await page.locator(`[data-dismiss-success="${direction}"]`).click();
    demo.settings.language = 'en';
    for (const client of clients) client.write(`data: ${JSON.stringify(demo)}\n\n`);
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.match(await phone.innerText(), /Android phone/);
    await page.locator('#peer-address').evaluate(node => { node.placeholder = 'Recipient example address:port'; });
    await page.locator('.nav-item[data-page="settings"]').click();
    await capture('settings-en.png');
    // Preserve a cached/offline phone's type, while unknown platforms use a
    // neutral device label instead of being presented as a computer.
    demo.peers[0].online = false;
    demo.peers[1].platform = 'unknown-platform';
    for (const client of clients) client.write(`data: ${JSON.stringify(demo)}\n\n`);
    await page.waitForFunction(() => document.querySelector('#all-devices [data-peer="demo-phone"]').disabled);
    assert.match(await page.locator('#all-devices [data-peer="demo-phone"]').innerText(), /Android phone/);
    assert.match(await page.locator('#all-devices [data-peer="demo-pc"] .online-label').innerText(), /Device/);
    assert.deepEqual(pageErrors, []);
    console.log('Four README screenshots regenerated from fixed demo data; no numeric IPs or machine identities. Android online/offline icons and bilingual labels passed.');
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
