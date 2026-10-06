const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { prepareStorage, readState, validReceiveDirectory } = require('../desktop/storage');
const { createApp } = require('../server/app');

async function fixture(t) {
  const root = path.join(__dirname, '..', '.landrop');
  await fs.mkdir(root, { recursive: true });
  const base = await fs.mkdtemp(path.join(root, 'storage-qa-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const installDir = path.join(base, '安装 测试', '局域传送');
  const legacyDataDir = path.join(base, 'legacy');
  const oldDefaultReceiveDir = path.join(base, 'old-files');
  await fs.mkdir(legacyDataDir); await fs.mkdir(oldDefaultReceiveDir);
  return { base, installDir, legacyDataDir, oldDefaultReceiveDir };
}
test('首次安装使用安装目录，升级保留身份、目录及已删除文字的状态', async t => {
  const options = await fixture(t);
  const storage = await prepareStorage(options);
  const first = await createApp({ dataDir: storage.dataDir, port: 0 });
  const id = first.info().id;
  assert.equal(first.state().settings.receiveDir, path.join(options.installDir, '接收文件'));
  await fs.writeFile(path.join(first.state().settings.receiveDir, '个人文件.txt'), '保留');
  await first.close();
  await fs.writeFile(path.join(options.legacyDataDir, 'state.json'), JSON.stringify({ id: '旧身份', history: [{ id: 'deleted-text', text: '已删除文字' }] }));
  const next = await prepareStorage({ ...options, confirmMigration: () => { throw new Error('不得重复导入旧数据'); } });
  const second = await createApp({ dataDir: next.dataDir, port: 0 });
  assert.equal(second.info().id, id);
  assert.equal(second.state().transfers.length, 0);
  assert.equal(await fs.readFile(path.join(storage.receiveDir, '个人文件.txt'), 'utf8'), '保留');
  await second.close();
  // A retained marker also prevents re-import if the local state file was intentionally removed.
  await fs.unlink(path.join(next.dataDir, 'state.json'));
  await prepareStorage(options);
  assert.equal((await readState(path.join(next.dataDir, 'state.json'))).history, undefined);
});
test('便携旧版迁移校验文件、更新历史路径并保留原件和互配身份', async t => {
  const options = await fixture(t), source = options.oldDefaultReceiveDir;
  await fs.mkdir(path.join(source, '子目录'));
  await fs.writeFile(path.join(source, '子目录', '图片.png'), Buffer.from([0, 1, 2, 255]));
  await fs.writeFile(path.join(source, '已清空历史仍保留的文件.txt'), '保留');
  await fs.writeFile(path.join(source, 'unfinished.part'), '中断');
  const original = { id: 'fixed-id', name: '测试设备', enabled: false, peers: [{ id: 'peer' }], receiveDir: source, history: [{ id: 'file', kind: 'file', direction: 'incoming', status: 'completed', path: path.join(source, '子目录', '图片.png') }, { id: 'text', kind: 'text', text: '保留消息' }] };
  await fs.writeFile(path.join(options.legacyDataDir, 'state.json'), JSON.stringify(original));
  const storage = await prepareStorage({ ...options, confirmMigration: async directory => { assert.equal(directory, source); return true; } });
  const migrated = await readState(path.join(storage.dataDir, 'state.json'));
  assert.equal(migrated.id, original.id); assert.deepEqual(migrated.peers, original.peers);
  assert.equal(migrated.enabled, false); assert.equal(migrated.history[1].text, '保留消息');
  assert.equal(migrated.history[0].path, path.join(storage.receiveDir, '子目录', '图片.png'));
  assert.deepEqual(await fs.readFile(migrated.history[0].path), await fs.readFile(original.history[0].path));
  assert.equal(await fs.readFile(path.join(storage.receiveDir, '已清空历史仍保留的文件.txt'), 'utf8'), '保留');
  await assert.rejects(fs.access(path.join(storage.receiveDir, 'unfinished.part')));
  assert.deepEqual(await readState(path.join(options.legacyDataDir, 'state.json')), original);
});
test('取消迁移、目标冲突与损坏配置都不会覆盖已有数据', async t => {
  const options = await fixture(t);
  const original = { id: 'original', receiveDir: options.oldDefaultReceiveDir };
  const file = path.join(options.legacyDataDir, 'state.json');
  await fs.writeFile(file, JSON.stringify(original));
  await assert.rejects(prepareStorage({ ...options, confirmMigration: async () => false }), /迁移尚未完成/);
  await fs.mkdir(path.join(options.installDir, '接收文件'));
  await fs.writeFile(path.join(options.installDir, '接收文件', '已有文件.txt'), '不要删除');
  await assert.rejects(prepareStorage({ ...options, confirmMigration: async () => true }), /已有内容/);
  assert.equal(await fs.readFile(path.join(options.installDir, '接收文件', '已有文件.txt'), 'utf8'), '不要删除');
  assert.deepEqual(await readState(file), original);
  await fs.writeFile(file, '{broken');
  await assert.rejects(prepareStorage(options), /原文件已保留/);
  await assert.rejects(createApp({ dataDir: options.legacyDataDir, port: 0 }), /原文件已保留/);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});
test('中断于文件提交后可恢复配置提交，禁止把接收目录设进程序资源', async t => {
  const options = await fixture(t), dataRoot = path.join(options.installDir, '数据');
  await fs.mkdir(path.join(dataRoot, '.迁移暂存'), { recursive: true });
  await fs.mkdir(path.join(options.installDir, '接收文件'), { recursive: true });
  await fs.writeFile(path.join(dataRoot, '.迁移暂存', 'state.json'), JSON.stringify({ id: 'recover-id', receiveDir: path.join(options.installDir, '接收文件') }));
  const storage = await prepareStorage(options);
  assert.equal((await readState(path.join(storage.dataDir, 'state.json'))).id, 'recover-id');
  assert.equal(validReceiveDirectory(options.installDir, options.installDir), false);
  assert.equal(validReceiveDirectory(options.installDir, path.join(options.installDir, 'resources', 'files')), false);
  assert.equal(validReceiveDirectory(options.installDir, path.join(options.installDir, '数据')), false);
  assert.equal(validReceiveDirectory(options.installDir, storage.receiveDir), true);
  assert.equal(validReceiveDirectory(options.installDir, path.join(options.base, 'other')), true);
});
test('安装到旧接收目录内部时停止迁移，防止递归复制自身', async t => {
  const options = await fixture(t);
  options.installDir = path.join(options.oldDefaultReceiveDir, '局域传送');
  await fs.writeFile(path.join(options.legacyDataDir, 'state.json'), JSON.stringify({ id: 'original', receiveDir: options.oldDefaultReceiveDir }));
  await assert.rejects(prepareStorage({ ...options, confirmMigration: async () => true }), /旧接收文件夹之外/);
  assert.equal((await readState(path.join(options.legacyDataDir, 'state.json'))).id, 'original');
});
