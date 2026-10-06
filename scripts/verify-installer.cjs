// Run only against the two isolated QA builds documented in README. Never use a production installer here.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createApp } = require('../server/app');
const root = path.resolve(__dirname, '..');
const build = path.join(root, '.landrop', 'installer-qa-build');
const base = path.join(root, '.landrop', '安装验证 空格目录');
const installDir = path.join(base, '局域传送安装验证');
const exe = path.join(installDir, '局域传送安装验证.exe');
const stateFile = path.join(installDir, '数据', '配置', 'state.json');
function run(file, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' });
    const timer = setTimeout(() => { reject(new Error('安装测试超时，测试进程保持原样以便检查')); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}
async function launch() {
  const env = { ...process.env, LANDROP_PORT: '0' }; delete env.LANDROP_PROFILE; delete env.ELECTRON_RUN_AS_NODE;
  const desktop = await _electron.launch({ executablePath: exe, env });
  const page = await desktop.firstWindow();
  await page.locator('#device-name').waitFor();
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.hide()));
  return { desktop, page };
}
async function state(page) { return page.evaluate(async () => (await (await fetch('/api/state')).json())); }
async function api(page, route, data, method = 'POST') {
  return page.evaluate(async ({ route, data, method }) => {
    const state = await (await fetch('/api/state')).json();
    const response = await fetch(route, { method, headers: { 'X-App-Token': state.uiToken, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { route, data, method });
}
(async () => {
  let desktop, receiver;
  await assert.rejects(fs.access(exe), '测试目录已有程序，请先检查并卸载先前的 QA 版本');
  try {
    assert.equal(await run(path.join(build, 'LanDrop-0.3.99-Setup.exe'), ['/S', '/currentuser', `/D=${installDir}`]), 0);
    await fs.access(exe);
    let launched = await launch(); desktop = launched.desktop; let page = launched.page;
    const initial = await state(page), id = initial.self.id;
    assert.equal(initial.settings.receiveDir, path.join(installDir, '接收文件'));
    const retained = path.join(initial.settings.receiveDir, '保留文件.bin');
    const payload = Buffer.from('覆盖升级保留二进制 ✓'); await fs.writeFile(retained, payload);
    await fs.writeFile(path.join(installDir, '用户自行放入.txt'), '保留个人文件');
    // An unlisted file in a program directory must also survive the generated removal manifest.
    await fs.writeFile(path.join(installDir, 'resources', '个人附加文件.txt'), '保留');
    receiver = await createApp({ dataDir: path.join(base, 'receiver'), name: 'QA 对端', port: 0 });
    await api(page, '/api/peers', { address: `127.0.0.1:${receiver.port}` });
    const pair = await fetch(`http://127.0.0.1:${receiver.port}/api/peers`, { method: 'POST', headers: { 'X-App-Token': receiver.state().uiToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ address: `127.0.0.1:${initial.self.port}` }) }); assert.equal(pair.status, 200);
    await receiver.sendText(id, '升级后仍可查看的文字');
    await receiver.sendText(id, '已经删除的文字不得恢复');
    const deleted = (await state(page)).transfers.find(job => job.text === '已经删除的文字不得恢复');
    await api(page, `/api/history/${deleted.id}`, undefined, 'DELETE');
    const before = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const child = desktop.process(), closed = desktop.waitForEvent('close');
    // Upgrade while hidden in the tray. The installer must request a graceful quit.
    assert.equal(await run(path.join(build, 'LanDrop-0.4.0-Setup.exe'), ['/S', '/currentuser']), 0);
    await closed; desktop = undefined;
    assert.notEqual(child.exitCode, null);
    assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')), before, '安装器不得修改配置和消息');
    assert.deepEqual(await fs.readFile(retained), payload);
    assert.equal(await fs.readFile(path.join(installDir, '用户自行放入.txt'), 'utf8'), '保留个人文件');
    assert.equal(await fs.readFile(path.join(installDir, 'resources', '个人附加文件.txt'), 'utf8'), '保留');
    launched = await launch(); desktop = launched.desktop; page = launched.page;
    assert.equal(await desktop.evaluate(({ app }) => app.getVersion()), '0.4.0');
    const after = await state(page);
    assert.equal(after.self.id, id);
    assert.equal(after.peers[0].id, receiver.info().id);
    assert.ok(after.transfers.some(job => job.text === '升级后仍可查看的文字'));
    assert.ok(!after.transfers.some(job => job.text === '已经删除的文字不得恢复'));
    // A prepared incoming file counts as an active transfer, even before bytes arrive.
    const localInfo = await (await fetch(`http://127.0.0.1:${after.self.port}/peer/info`)).json();
    await desktop.evaluate(({ dialog }) => { globalThis.updatePrompts = 0; dialog.showMessageBox = async () => { globalThis.updatePrompts++; return { response: 0 }; }; });
    const ready = await fetch(`http://127.0.0.1:${after.self.port}/peer/request`, { method: 'POST', headers: { 'X-Lan-Token': localInfo.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: receiver.info(), kind: 'file', name: '传输中的文件.bin', size: 1024 }) });
    assert.equal(ready.status, 200); const pending = await ready.json();
    assert.equal(await run(path.join(build, 'LanDrop-0.4.0-Setup.exe'), ['/S', '/currentuser']), 2);
    assert.equal((await state(page)).transfers.find(job => job.id === pending.id).status, 'ready');
    assert.equal(await desktop.evaluate(() => globalThis.updatePrompts), 1);
    await fs.access(exe);
    await api(page, '/api/cancel', { id: pending.id });
    const quit = desktop.waitForEvent('close'); await desktop.evaluate(({ app }) => setTimeout(() => app.quit(), 50)); await quit; desktop = undefined;
    const uninstaller = (await fs.readdir(installDir)).find(name => name.startsWith('Uninstall') && name.endsWith('.exe'));
    assert.ok(uninstaller);
    assert.equal(await run(path.join(installDir, uninstaller), ['/S', '/currentuser']), 0);
    // NSIS delegates the running uninstaller to a temporary copy; wait for that copy to finish.
    for (let attempt = 0; attempt < 60; attempt++) {
      if (!await fs.access(exe).then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await assert.rejects(fs.access(exe));
    assert.deepEqual(await fs.readFile(retained), payload);
    assert.equal((JSON.parse(await fs.readFile(stateFile, 'utf8'))).id, id);
    assert.equal(await fs.readFile(path.join(installDir, 'resources', '个人附加文件.txt'), 'utf8'), '保留');
    console.log('安装器验证通过：D 盘中文与空格路径、0.3.99 → 0.4.0 覆盖升级、托盘后台正常退出、传输中阻止覆盖、身份/互配/文字/文件保留、已删除文字不恢复、卸载保留个人数据。');
  } finally { await desktop?.close(); await receiver?.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
