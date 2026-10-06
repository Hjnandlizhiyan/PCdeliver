// README screenshots use only fixed demonstration data, never local device state.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const demo = {
  self: { id: 'demo-device', name: '示例电脑', platform: 'win32', port: 45878, addresses: ['局域网 IP'],
    interfaces: [{ name: 'Wi-Fi（示例）', address: '局域网 IP', virtual: false }, { name: '虚拟网卡（示例）', address: '虚拟网卡 IP', virtual: true }] },
  settings: { receiveDir: '接收文件夹', enabled: true },
  peers: [], transfers: [], warning: '', uiToken: 'demo-preview'
};
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'application/javascript; charset=utf-8']],
  ['/i18n.js', ['i18n.js', 'application/javascript; charset=utf-8']],
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
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('#device-name').filter({ hasText: demo.self.name }).waitFor();
    await page.evaluate(async () => Promise.all([...document.images].map(image => image.decode())));
    assert.equal(await page.locator('#local-address').textContent(), '局域网 IP:45878');
    assert.equal(await page.locator('#receive-directory').textContent(), '接收文件夹');
    assert.equal(await page.locator('#self-name').textContent(), '示例电脑');
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'docs', 'preview.png'), fullPage: true });
    await page.locator('.nav-item[data-page="devices"]').click();
    assert.equal(await page.locator('.local-interface').count(), 2);
    await page.screenshot({ path: path.join(root, 'docs', 'connections.png'), fullPage: true });
    await page.locator('.nav-item[data-page="home"]').click();
    const createdAt = Date.now();
    demo.transfers = ['incoming', 'outgoing'].map(direction => ({
      id: `demo-${direction}`, kind: 'file', direction, status: 'completed',
      name: direction === 'incoming' ? '示例图片.png' : '示例文档.pdf', peerName: '另一台示例电脑',
      size: 1048576, createdAt, updatedAt: createdAt, progress: 100, bytes: 1048576
    }));
    for (const client of clients) client.write(`data: ${JSON.stringify(demo)}\n\n`);
    await page.locator('[data-success-direction="incoming"]').waitFor();
    await page.locator('[data-success-direction="outgoing"]').waitFor();
    await page.evaluate(async () => Promise.all([...document.images].map(image => image.decode())));
    await page.locator('.success-notice').evaluateAll(elements => Promise.all(elements.flatMap(element => element.getAnimations().map(animation => animation.finished.catch(() => {})))));
    await page.screenshot({ path: path.join(root, 'docs', 'transfer-success.png'), fullPage: true });
    console.log('README 预览图已使用固定演示数据生成。');
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
