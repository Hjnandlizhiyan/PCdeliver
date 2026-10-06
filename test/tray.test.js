const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTray } = require('../desktop/tray');

test('托盘的打开、隐藏和退出动作独立，单击和双击可唤回窗口，退出时图标销毁', () => {
  let instance, destroyed = 0, opened = 0, hidden = 0, quit = 0;
  class Tray {
    constructor() { instance = this; this.events = new Map(); }
    setToolTip(tooltip) { this.tooltip = tooltip; }
    setContextMenu(menu) { this.menu = menu; }
    on(event, callback) { this.events.set(event, callback); }
    isDestroyed() { return destroyed > 0; }
    destroy() { destroyed++; }
  }
  const controller = createTray({ Tray, Menu: { buildFromTemplate: items => items }, nativeImage: { createFromPath: () => ({ isEmpty: () => false }) } }, {
    showWindow: () => opened++, hideWindow: () => hidden++, openFolder() {}, quit: () => quit++
  }, 'test');
  instance.menu.find(item => item.label === '隐藏窗口（继续运行）').click();
  assert.equal(hidden, 1); assert.equal(quit, 0);
  instance.events.get('click')(); instance.events.get('double-click')();
  instance.menu.find(item => item.label === '打开窗口').click();
  assert.equal(opened, 3);
  instance.menu.find(item => item.label === '退出软件（停止传输）').click();
  assert.equal(quit, 1); assert.equal(hidden, 1);
  assert.match(instance.tooltip, /右键可退出/);
  controller.destroy(); controller.destroy(); assert.equal(destroyed, 1);
});

test('图标加载失败时阻止软件在没有托盘入口的情况下运行', () => {
  assert.throws(() => createTray({ nativeImage: { createFromPath: () => ({ isEmpty: () => true }) } }, {}, 'test'), /托盘图标加载失败/);
});
