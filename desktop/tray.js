const path = require('node:path');

function createTray({ Tray, Menu, nativeImage }, actions, version, platform = process.platform) {
  const image = nativeImage.createFromPath(path.join(__dirname, platform === 'win32' ? 'icon.ico' : 'icon.png'));
  if (image.isEmpty()) throw new Error('托盘图标加载失败');
  const tray = new Tray(image);
  tray.setToolTip(`局域传送 v${version}\n右键可退出软件`);
  const menu = Menu.buildFromTemplate([
    { label: `局域传送 · v${version}`, enabled: false },
    { type: 'separator' },
    { label: '打开窗口', click: actions.showWindow },
    { label: '隐藏窗口（继续运行）', click: actions.hideWindow },
    { label: '打开接收文件夹', click: actions.openFolder },
    { type: 'separator' },
    { label: '退出软件（停止传输）', click: actions.quit }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', actions.showWindow);
  tray.on('double-click', actions.showWindow);
  return {
    destroy() { if (!tray.isDestroyed()) tray.destroy(); }
  };
}

module.exports = { createTray };
