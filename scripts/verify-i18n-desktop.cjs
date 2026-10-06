const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

(async () => {
  const output = path.join(root, 'test-output', 'i18n');
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, 'desktop-'));
  let desktop;
  async function launch() {
    const env = { ...process.env, LANDROP_PROFILE: profile, LANDROP_PORT: '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = await _electron.launch({ executablePath: path.join(root, 'release', 'win-unpacked', '局域传送.exe'), env });
    await desktop.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.setBackgroundThrottling(false);
        window.hide();
      }
    });
    const page = await desktop.firstWindow();
    await page.waitForFunction(() => document.querySelector('#settings-language') && document.querySelector('#device-name').textContent !== '这台电脑');
    await desktop.evaluate(({ Menu, Tray, dialog }) => {
      globalThis.languageChecks = { menus: [], tooltips: [], dialogs: [] };
      const build = Menu.buildFromTemplate;
      Menu.buildFromTemplate = items => { globalThis.languageChecks.menus.push(items.map(item => item.label).filter(Boolean)); return build(items); };
      const tooltip = Tray.prototype.setToolTip;
      Tray.prototype.setToolTip = function (text) { globalThis.languageChecks.tooltips.push(text); return tooltip.call(this, text); };
      dialog.showOpenDialog = async (_window, options) => { globalThis.languageChecks.dialogs.push(options.title); return { canceled: true, filePaths: [] }; };
    });
    return page;
  }
  try {
    let page = await launch();
    await page.locator('[data-page=settings].nav-item').click();
    await page.locator('#settings-language').selectOption('en');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    const adapters = await page.evaluate(async () => {
      const data = await (await fetch('/api/state')).json();
      return { source: data.self.interfaces, labels: [...document.querySelectorAll('.local-interface span')].map(node => node.textContent) };
    });
    adapters.source.forEach((item, index) => {
      if (/^以太网(?:\s+\d+)?$/.test(item.name)) assert.equal(adapters.labels[index], item.name.replace('以太网', 'Ethernet'));
    });
    await page.evaluate(async () => { await window.desktop.selectFiles(); await window.desktop.chooseFolder(); });
    const en = await desktop.evaluate(() => globalThis.languageChecks);
    assert.deepEqual(en.dialogs, ['Choose files to send', 'Choose the receive folder']);
    assert.ok(en.menus.at(-1).includes('Quit (stop transfers)'));
    assert.match(en.tooltips.at(-1), /Right-click to quit/);
    assert.match(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), /LanDrop/);
    assert.equal(await page.locator('#choose-folder').textContent(), 'Change');
    // Demonstration screenshot uses neutral device and folder names.
    await page.locator('#settings-name').fill('Demo PC');
    await page.locator('#settings-form button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#self-name').textContent === 'Demo PC');
    await page.locator('#receive-directory').evaluate(node => { node.textContent = 'D:\\LanDrop\\Received'; });
    await page.locator('#toast').evaluate(node => { node.hidden = true; });
    await page.screenshot({ path: path.join(output, 'desktop-settings-en.png'), fullPage: true });
    await page.locator('#settings-language').selectOption('zh-CN');
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    await page.evaluate(async () => { await window.desktop.selectFiles(); await window.desktop.chooseFolder(); });
    const zh = await desktop.evaluate(() => globalThis.languageChecks);
    assert.deepEqual(zh.dialogs.slice(-2), ['选择要传输的文件', '选择接收目录']);
    assert.ok(zh.menus.at(-1).includes('退出软件（停止传输）'));
    assert.match(zh.tooltips.at(-1), /右键可退出软件/);
    await page.locator('#settings-language').selectOption('en');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await desktop.close(); desktop = undefined;
    page = await launch();
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.match(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), /LanDrop/);
    console.log('Packaged desktop passed: bilingual tray, tooltips, native dialog titles, window title, and restart persistence.');
  } finally { await desktop?.close(); await fs.rm(profile, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
