const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createApp } = require('../server/app');
const { createTray } = require('./tray');
const { prepareStorage, validReceiveDirectory, readState } = require('./storage');
const { translate, translateError } = require('../public/i18n');
let startupLanguage = 'zh-CN';
const currentLanguage = () => service?.state().settings.language || startupLanguage;
const t = (key, values) => translate(currentLanguage(), key, values);
const errorText = message => translateError(currentLanguage(), message);
let service, window, tray, exiting = false, cleanupFinished = false;
const legacyDataDir = path.join(app.getPath('userData'), 'landrop');
const installed = app.isPackaged && !process.env.LANDROP_PROFILE;
const installDir = path.dirname(process.execPath);
let storage, pendingUpdateQuit = false;
const allowedFiles = new Set();
function showWindow() {
  if (!window || window.isDestroyed() || exiting) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}
if (process.env.LANDROP_PROFILE) app.setPath('userData', path.resolve(process.env.LANDROP_PROFILE));
else if (installed) {
  const profile = path.join(installDir, '数据', '运行缓存');
  require('node:fs').mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.setPath('crashDumps', path.join(installDir, '数据', '崩溃记录'));
  app.setAppLogsPath(path.join(installDir, '数据', '日志'));
}
function quitForUpdate() {
  if (!service) { pendingUpdateQuit = true; return; }
  if (service.hasActiveTransfers()) {
    showWindow();
    dialog.showMessageBox(window, { type: 'info', title: t('请先结束传输'), message: t('软件正在传输，暂时不能覆盖安装。'), detail: t('请等待传输完成，或在软件里取消传输，再回到安装器点击“重试”。'), buttons: [t('知道了')] });
    return;
  }
  app.quit();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv = []) => { if (argv.includes('--quit-for-update')) quitForUpdate(); else showWindow(); });
  app.on('activate', showWindow);
  app.whenReady().then(async () => {
    // A shutdown helper must never initialize a second installation or start a migration.
    if (process.argv.includes('--quit-for-update')) { app.quit(); return; }
    app.setAppUserModelId('local.landrop.desktop');
    const settingsFile = installed ? path.join(installDir, '数据', '配置', 'state.json') : path.join(app.getPath('userData'), 'landrop', 'state.json');
    const previousSettings = await readState(settingsFile);
    startupLanguage = previousSettings?.language === 'en' ? 'en' : 'zh-CN';
    if (installed) storage = await prepareStorage({ installDir, legacyDataDir, oldDefaultReceiveDir: path.join(app.getPath('downloads'), '局域传送'), confirmMigration: async sourceDir => {
      const result = await dialog.showMessageBox({ type: 'question', title: t('迁移旧版数据'), message: t('发现这台电脑的旧版数据。'), detail: t('迁移说明：{path}', { path: sourceDir }), buttons: [t('迁移并开始'), t('暂不迁移（退出）')], defaultId: 0, cancelId: 1 });
      return result.response === 0;
    } });
    service = await createApp({ dataDir: storage?.dataDir || path.join(app.getPath('userData'), 'landrop'), port: Number(process.env.LANDROP_PORT || 45878), onLanguageChanged: language => { tray?.setLanguage(language); if (window && !window.isDestroyed()) window.setTitle(t('局域传送')); } });
    if (!installed && !process.env.LANDROP_PROFILE && service.state().settings.receiveDir.startsWith(app.getPath('userData'))) await service.setReceiveDir(path.join(app.getPath('downloads'), '局域传送'));
    if (pendingUpdateQuit) { quitForUpdate(); return; }
    window = new BrowserWindow({ width: 1380, height: 900, minWidth: 1040, minHeight: 740, title: t('局域传送'), icon: path.join(__dirname, 'icon.png'), backgroundColor: '#f6f8fa', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.on('closed', () => { window = undefined; });
    tray = createTray({ Tray, Menu, nativeImage }, {
      showWindow,
      hideWindow: () => { if (!exiting && window && !window.isDestroyed()) window.hide(); },
      openFolder: async () => {
        if (exiting) return;
        try { const error = await shell.openPath(service.state().settings.receiveDir); if (error) dialog.showErrorBox(t('无法打开接收文件夹'), error); }
        catch (error) { dialog.showErrorBox(t('无法打开接收文件夹'), error.message); }
      },
      quit: () => app.quit()
    }, app.getVersion(), process.platform, currentLanguage());
    const origin = `http://127.0.0.1:${service.port}`;
    function trusted(event) { if (!window || window.isDestroyed() || event.sender !== window.webContents || new URL(event.senderFrame.url).origin !== origin) throw new Error(t('不受信任的窗口')); }
    ipcMain.handle('select-files', async event => { trusted(event); const result = await dialog.showOpenDialog(window, { title: t('选择要传输的文件'), properties: ['openFile', 'multiSelections'] }); for (const file of result.filePaths) allowedFiles.add(file); return result.filePaths.map(file => ({ path: file, name: path.basename(file) })); });
    ipcMain.handle('send-files', async (event, { peerId, files }) => { trusted(event); if (!Array.isArray(files) || files.some(file => !allowedFiles.has(file))) throw new Error(t('请通过文件选择窗口添加文件')); if (!service.state().peers.some(p => p.id === peerId && p.online)) throw new Error(t('接收设备已离线')); for (const file of files) { const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 20 * 1024 ** 3) throw new Error(t('请选择 20 GB 以内的文件；文件夹请先压缩')); } for (const file of files) service.sendLocalFile(peerId, file).catch(() => {}); return { ok: true }; });
    ipcMain.handle('choose-folder', async event => { trusted(event); const result = await dialog.showOpenDialog(window, { title: t('选择接收目录'), defaultPath: service.state().settings.receiveDir, properties: ['openDirectory', 'createDirectory'] }); if (!result.canceled) { if (installed && !validReceiveDirectory(installDir, result.filePaths[0])) throw new Error(t('请选择“接收文件”或其他普通文件夹，不要选择程序根目录、运行文件或数据文件夹')); await service.setReceiveDir(result.filePaths[0]); } return service.state().settings.receiveDir; });
    ipcMain.handle('open-folder', async event => { trusted(event); return shell.openPath(service.state().settings.receiveDir); });
    ipcMain.handle('show-file', async (event, id) => { trusted(event); const file = service.getReceivedPath(id); if (file) shell.showItemInFolder(file); });
    ipcMain.handle('copy-text', (event, text) => { trusted(event); if (typeof text === 'string' && text.length <= 100000) clipboard.writeText(text); });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
    await window.loadURL(origin);
  }).catch(err => { dialog.showErrorBox(t('局域传送无法启动'), err.code === 'EADDRINUSE' ? t('端口 45878 已被占用。请先关闭浏览器版或其他实例。') : errorText(err.message)); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (cleanupFinished) return;
    event.preventDefault();
    if (exiting) return;
    exiting = true;
    Promise.resolve().then(() => service?.close()).catch(error => console.error('退出清理失败：', error.message)).finally(() => {
      allowedFiles.clear(); tray?.destroy(); tray = undefined;
      cleanupFinished = true; app.quit();
    });
  });
  app.on('will-quit', () => { tray?.destroy(); tray = undefined; });
}
