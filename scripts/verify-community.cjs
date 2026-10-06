const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const links = require('../public/community-links');
const root = path.resolve(__dirname, '..');
(async () => {
  const output = path.join(root, '.landrop', 'community-verification');
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, 'desktop-'));
  const env = { ...process.env, LANDROP_PROFILE: profile, LANDROP_PORT: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  const desktop = await _electron.launch({ executablePath: path.join(root, 'release/win-unpacked/局域传送.exe'), env });
  try {
    await desktop.evaluate(({ BrowserWindow, shell }) => {
      for (const window of BrowserWindow.getAllWindows()) { window.webContents.setBackgroundThrottling(false); window.hide(); }
      globalThis.openedCommunityUrls = [];
      shell.openExternal = async url => { globalThis.openedCommunityUrls.push(url); };
    });
    const page = await desktop.firstWindow();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => typeof state !== 'undefined' && state);
    await page.waitForFunction(() => typeof LanDropCommunityLinks !== 'undefined');
    const origin = page.url();
    await page.locator('.nav-item[data-page=settings]').click();
    for (const [key, url] of Object.entries(links)) {
      const link = page.locator(`[data-community-link=${key}]`);
      assert.equal(await link.getAttribute('href'), url);
      await link.click();
    }
    await page.waitForTimeout(200);
    assert.deepEqual(await desktop.evaluate(() => globalThis.openedCommunityUrls), Object.values(links));
    assert.equal(page.url(), origin);
    for (const url of ['file:///C:/Windows', 'https://github.com/Hjnandlizhiyan?other=1', 'https://github.com.evil.test/Hjnandlizhiyan']) {
      assert.equal(await page.evaluate(url => desktop.openExternal(url).then(() => false, () => true), url), true);
    }
    await page.locator('#copy-qq-group').click();
    await page.waitForFunction(() => document.getElementById('toast').textContent === t('群号已复制'));
    assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), '305402575');
    for (const language of ['en', 'zh-CN']) {
      await page.locator('#settings-language').selectOption(language);
      await page.waitForFunction(language => document.documentElement.lang === language, language);
      const labels = await page.locator('.community-panel').innerText();
      assert.match(labels, language === 'en' ? /Creator & community/ : /作者与社区/);
      if (language === 'en') assert.doesNotMatch(labels, /[\u4e00-\u9fff]/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.locator('.community-panel').screenshot({ path: path.join(output, 'windows-community.png') });
    assert.deepEqual(errors, []);
    const report = { version: await desktop.evaluate(({ app }) => app.getVersion()), allThreeLinksPassed: true, externalBrowserBridgePassed: true, blockedOtherUrls: true, qqClipboardPassed: true, bilingualLayoutPassed: true };
    await fs.writeFile(path.join(output, 'windows.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await desktop.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
