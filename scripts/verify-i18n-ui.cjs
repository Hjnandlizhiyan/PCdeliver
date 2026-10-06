// Exercise the real local service and UI with disposable demonstration data.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');
const { createApp } = require('../server/app');
const output = path.join(__dirname, '..', 'test-output', 'i18n');

(async () => {
  await fs.mkdir(output, { recursive: true });
  const directory = await fs.mkdtemp(path.join(output, 'run-'));
  let a, b, browser;
  const errors = [];
  const originalInterfaces = os.networkInterfaces;
  // Simulate Chinese Windows labels in this test process, including event updates.
  os.networkInterfaces = () => Object.fromEntries(['以太网', '以太网 2', '办公网络'].map((name, index) => [name, [
    { family: 'IPv4', internal: false, address: `192.168.1.${10 + index}`, netmask: '255.255.255.0' }
  ]]));
  const post = (app, route, data) => fetch(`http://127.0.0.1:${app.port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': app.state().uiToken }, body: JSON.stringify(data)
  });
  try {
    a = await createApp({ port: 0, name: 'Demo PC A', dataDir: path.join(directory, 'a') });
    b = await createApp({ port: 0, name: 'Demo PC B', dataDir: path.join(directory, 'b') });
    assert.equal((await post(a, '/api/peers', { address: `127.0.0.1:${b.port}` })).status, 200);
    assert.equal((await post(b, '/api/peers', { address: `127.0.0.1:${a.port}` })).status, 200);
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1380, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => { if (msg.type() === 'error' && !msg.text().includes('400 (Bad Request)')) errors.push(msg.text()); });
    await page.goto(`http://127.0.0.1:${a.port}`);
    await page.waitForFunction(() => document.querySelector('#device-name').textContent === 'Demo PC A');
    await page.locator('[data-page=settings].nav-item').click();
    await page.locator('#settings-name').fill('未保存的名称');
    await page.locator('#lan-enabled').uncheck();
    await page.locator('#settings-language').selectOption('en');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.deepEqual(await page.locator('.local-interface span').allTextContents(), ['Ethernet', 'Ethernet 2', '办公网络']);
    assert.equal(await page.locator('#settings-name').inputValue(), '未保存的名称');
    assert.equal(await page.locator('#lan-enabled').isChecked(), false);
    assert.equal(a.state().self.name, 'Demo PC A');
    assert.equal(a.state().settings.enabled, true);
    assert.equal(await page.locator('#page-title').textContent(), 'Share your way.');
    assert.equal(await page.title(), 'LanDrop · Share a little closer');
    await page.locator('#settings-language').selectOption('zh-CN');
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    assert.deepEqual(await page.locator('.local-interface span').allTextContents(), ['以太网', '以太网 2', '办公网络']);
    assert.equal(await page.title(), '局域传送 · 让分享近一点');
    await page.locator('#settings-language').selectOption('en');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await page.locator('[data-page=devices].nav-item').click();
    await page.locator('#peer-address').fill('invalid');
    await page.locator('#connect-button').click();
    await page.waitForFunction(() => !document.querySelector('#connection-error').hidden);
    assert.match(await page.locator('#connection-error').textContent(), /Enter a LAN IPv4 address/);
    await page.locator('[data-page=home].nav-item').click();
    await page.locator('#target-device').selectOption(b.info().id);
    await page.locator('[data-tab=text]').click();
    const content = '原始中文消息 — Hello <script> & {count}';
    await page.locator('#text-content').fill(content);
    assert.match(await page.locator('#text-counter').textContent(), /characters/);
    await page.locator('#send-button').click();
    await page.locator('[data-success-direction=outgoing]').waitFor();
    assert.match(await page.locator('[data-success-direction=outgoing]').textContent(), /Text sent/);
    assert.equal(b.state().settings.language, 'zh-CN');
    assert.equal(b.state().transfers.find(job => job.kind === 'text').text, content);
    await page.locator('#recent-history [data-message]').first().click();
    assert.equal(await page.locator('#received-message').textContent(), content);
    await page.locator('[data-close=message-dialog]').click();
    await b.sendText(a.info().id, 'Received demo message');
    await page.locator('[data-success-direction=incoming]').waitFor();
    assert.match(await page.locator('[data-success-direction=incoming]').textContent(), /Text received/);
    const file = path.join(directory, 'sample.txt');
    await fs.writeFile(file, 'Bilingual transfer integrity test');
    await page.locator('#file-input').setInputFiles(file);
    await page.locator('#send-button').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#recent-history tr')].some(row => row.textContent.includes('sample.txt') && row.textContent.includes('Completed')));
    const received = b.state().transfers.find(job => job.name === 'sample.txt');
    assert.equal(await fs.readFile(received.path, 'utf8'), 'Bilingual transfer integrity test');
    const sourceFile = path.join(directory, 'return.txt');
    await fs.writeFile(sourceFile, 'Return transfer');
    await b.sendLocalFile(a.info().id, sourceFile);
    await page.waitForFunction(() => [...document.querySelectorAll('#recent-history tr')].some(row => row.textContent.includes('return.txt') && row.textContent.includes('Completed')));
    // Trigger a legacy canonical error to verify history rendering in English.
    await post(b, '/api/settings', { enabled: false });
    await a.sendText(b.info().id, 'disabled transfer');
    await page.waitForFunction(() => document.querySelector('.transfer-error')?.textContent.includes('disabled LAN transfers'));
    for (const direction of ['incoming', 'outgoing']) {
      const dismiss = page.locator(`[data-dismiss-success=${direction}]`);
      if (await dismiss.count()) await dismiss.click();
    }
    for (const width of [1380, 1040]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of ['home', 'devices', 'history', 'settings']) {
        await page.locator(`[data-page=${view}].nav-item`).click();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${view} overflows at ${width}`);
        await page.locator('#toast').evaluate(node => { node.hidden = true; });
        await page.screenshot({ path: path.join(output, `${view}-en-${width}.png`), fullPage: true });
      }
    }
    await page.locator('#settings-language').selectOption('zh-CN');
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    await page.locator('[data-page=home].nav-item').click();
    assert.match(await page.locator('#recent-history').textContent(), /已完成/);
    await page.screenshot({ path: path.join(output, 'home-zh.png'), fullPage: true });
    await page.locator('[data-page=settings].nav-item').click();
    await page.locator('#settings-language').selectOption('en');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await page.reload();
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal(await page.locator('#page-title').textContent(), 'Share a little closer.');
    await a.close();
    a = await createApp({ port: 0, dataDir: path.join(directory, 'a') });
    await page.goto(`http://127.0.0.1:${a.port}`);
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal(a.state().settings.language, 'en');
    assert.equal(a.state().transfers.find(job => job.text === content).text, content);
    assert.deepEqual(errors, []);
    console.log('Bilingual UI passed: switching, saved settings, mixed-language file/text transfers, errors, restart, and desktop layouts.');
    console.log(`Screenshots: ${output}`);
  } finally {
    os.networkInterfaces = originalInterfaces;
    await browser?.close();
    await Promise.all([a?.close(), b?.close()]);
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
