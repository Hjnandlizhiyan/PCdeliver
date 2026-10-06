const path = require('node:path');
const { translate } = require('../public/i18n');

function createTray({ Tray, Menu, nativeImage }, actions, version, platform = process.platform, language = 'zh-CN') {
  const image = nativeImage.createFromPath(path.join(__dirname, platform === 'win32' ? 'icon.ico' : 'icon.png'));
  if (image.isEmpty()) throw new Error('托盘图标加载失败');
  const tray = new Tray(image);
  function setLanguage(nextLanguage) {
    const t = key => translate(nextLanguage, key);
    tray.setToolTip(`${t('局域传送')} v${version}\n${t('右键可退出软件')}`);
    const menu = Menu.buildFromTemplate([
      { label: `${t('局域传送')} · v${version}`, enabled: false },
      { type: 'separator' },
      { label: t('打开窗口'), click: actions.showWindow },
      { label: t('隐藏窗口（继续运行）'), click: actions.hideWindow },
      { label: t('打开接收文件夹'), click: actions.openFolder },
      { type: 'separator' },
      { label: t('退出软件（停止传输）'), click: actions.quit }
    ]);
    tray.setContextMenu(menu);
  }
  setLanguage(language);
  tray.on('click', actions.showWindow);
  tray.on('double-click', actions.showWindow);
  return {
    setLanguage,
    destroy() { if (!tray.isDestroyed()) tray.destroy(); }
  };
}

module.exports = { createTray };
