const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
(async () => {
  for (const version of ['0.3.99', '0.4.0']) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'node_modules/electron-builder/cli.js'), '--win', 'nsis', '--x64',
        '--config.electronDist=node_modules/electron/dist', '--config.appId=local.landrop.installerqa',
        '--config.productName=局域传送安装验证', '--config.extraMetadata.name=landrop-installerqa',
        `--config.extraMetadata.version=${version}`, '--config.directories.output=.landrop/installer-qa-build',
        '--config.nsis.createDesktopShortcut=false', '--config.nsis.createStartMenuShortcut=false'], { cwd: root, stdio: 'inherit', windowsHide: true });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`QA 构建失败：${code}`)));
    });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
