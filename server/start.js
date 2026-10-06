const { createApp } = require('./app');
const path = require('node:path');
createApp({ port: Number(process.env.LANDROP_PORT || 45878), dataDir: process.env.LANDROP_DATA_DIR ? path.resolve(process.env.LANDROP_DATA_DIR) : undefined, name: process.env.LANDROP_NAME }).then(app => {
  console.log(`局域传送已启动：http://127.0.0.1:${app.port}`);
  console.log(`接收目录：${app.state().settings.receiveDir}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
}).catch(err => { console.error(`启动失败：${err.code === 'EADDRINUSE' ? '45878 端口已被占用，请关闭其他实例或设置 LANDROP_PORT。' : err.message}`); process.exit(1); });
