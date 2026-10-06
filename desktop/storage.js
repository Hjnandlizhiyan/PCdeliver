const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function readState(file) {
  try {
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state) ||
      (state.history !== undefined && !Array.isArray(state.history)) ||
      (state.peers !== undefined && !Array.isArray(state.peers)) ||
      (state.receiveDir !== undefined && typeof state.receiveDir !== 'string')) throw new Error('数据格式不正确');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`无法读取本地数据，原文件已保留，请勿覆盖：${file}`, { cause: error });
  }
}
async function writable(directory) {
  await fs.mkdir(directory, { recursive: true });
  const probe = path.join(directory, `.landrop-write-${crypto.randomUUID()}`);
  await fs.writeFile(probe, '', { flag: 'wx' });
  await fs.unlink(probe);
}
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function copyVerified(source, destination) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error('旧接收文件夹包含链接，请先移出链接后重试迁移');
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const entry of await fs.readdir(source)) {
      if (entry.endsWith('.part')) continue;
      await copyVerified(path.join(source, entry), path.join(destination, entry));
    }
  } else if (stat.isFile()) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const before = await digest(source);
    await fs.copyFile(source, destination, require('node:fs').constants.COPYFILE_EXCL);
    if (before !== await digest(destination) || before !== await digest(source)) throw new Error('迁移时文件发生变化，请退出旧版后重试');
  } else throw new Error('旧接收目录包含不支持的文件类型');
}
function relativeInside(root, file) {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) ? relative : null;
}
async function prepareStorage({ installDir, legacyDataDir, oldDefaultReceiveDir, confirmMigration }) {
  const dataRoot = path.join(installDir, '数据');
  const dataDir = path.join(dataRoot, '配置');
  const receiveDir = path.join(installDir, '接收文件');
  const stateFile = path.join(dataDir, 'state.json');
  const marker = path.join(dataRoot, '存储标记.json');
  const stage = path.join(dataRoot, '.迁移暂存');
  await writable(installDir);
  await writable(dataDir);
  let existing = await readState(stateFile);
  const pending = path.join(stage, 'state.json');
  if (!existing && await readState(pending)) {
    try { await fs.access(path.join(stage, 'files')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.access(receiveDir);
      await fs.rename(pending, stateFile);
      existing = await readState(stateFile);
      await fs.rm(stage, { recursive: true, force: true });
    }
  }
  let initialized = false;
  try { await fs.access(marker); initialized = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!existing) {
    const legacy = !initialized && legacyDataDir ? await readState(path.join(legacyDataDir, 'state.json')) : null;
    let state = { receiveDir };
    if (legacy) {
      const sourceDir = legacy.receiveDir || oldDefaultReceiveDir;
      if (path.resolve(sourceDir) === path.resolve(installDir) || relativeInside(sourceDir, installDir)) throw new Error('安装目录位于旧接收文件夹内。请将软件安装到旧接收文件夹之外，再进行迁移，避免重复复制。');
      if (!confirmMigration || !await confirmMigration(sourceDir)) throw new Error('迁移尚未完成，旧版数据保持原样。请退出旧版后重新打开安装版。');
      await fs.rm(stage, { recursive: true, force: true });
      await fs.mkdir(stage, { recursive: true });
      const stagedFiles = path.join(stage, 'files');
      let committed = false;
      try {
        const sourceExists = await fs.access(sourceDir).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        if (sourceExists) await copyVerified(sourceDir, stagedFiles);
        else await fs.mkdir(stagedFiles, { recursive: true });
        state = { ...legacy, receiveDir, history: [] };
        let index = 0;
        for (const job of legacy.history || []) {
          const copied = { ...job };
          if (job.direction === 'incoming' && job.kind === 'file' && job.path) {
            let relative = relativeInside(sourceDir, job.path);
            if (!relative) {
              relative = path.join('旧目录文件', `${++index}-${path.basename(job.path)}`);
              try { await copyVerified(job.path, path.join(stagedFiles, relative)); }
              catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            copied.path = path.join(receiveDir, relative);
          }
          state.history.push(copied);
        }
        // Commit only after every copy has passed verification. Originals are never moved or deleted.
        await fs.writeFile(pending, JSON.stringify(state, null, 2), { flag: 'wx' });
        try { await fs.rmdir(receiveDir); } catch (error) { if (error.code !== 'ENOENT') throw new Error('新接收文件夹已有内容，迁移已停止，原文件保持不变'); }
        await fs.rename(stagedFiles, receiveDir);
        committed = true;
        await fs.rename(pending, stateFile);
      } finally { if (!committed || await readState(stateFile)) await fs.rm(stage, { recursive: true, force: true }); }
    }
    if (!legacy) {
      await fs.writeFile(`${stateFile}.tmp`, JSON.stringify(state, null, 2), { flag: 'w' });
      await fs.rename(`${stateFile}.tmp`, stateFile);
    }
  }
  await fs.writeFile(marker, JSON.stringify({ format: 1 }));
  return { dataRoot, dataDir, receiveDir };
}
function validReceiveDirectory(installDir, directory) {
  const relative = path.relative(installDir, directory);
  if (relative === '') return false;
  if (!relativeInside(installDir, directory)) return true;
  return !['数据', 'resources', 'locales'].includes(relative.split(path.sep)[0].toLowerCase());
}
module.exports = { prepareStorage, readState, validReceiveDirectory };
