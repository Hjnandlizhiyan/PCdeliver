const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { createApp, safeName } = require('../server/app');
let a, b, dir;
async function api(app, route, data, method = 'POST') {
  return fetch(`http://127.0.0.1:${app.port}${route}`, { method, headers: { 'Content-Type': 'application/json', 'X-App-Token': app.state().uiToken }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
}
async function waitFor(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error('等待状态超时');
}
before(async () => {
  await fsp.mkdir(path.join(__dirname, '..', 'test-output'), { recursive: true });
  dir = await fsp.mkdtemp(path.join(__dirname, '..', 'test-output', 'run-'));
  a = await createApp({ port: 0, name: '电脑 A', dataDir: path.join(dir, 'a') });
  b = await createApp({ port: 0, name: '电脑 B', dataDir: path.join(dir, 'b') });
  const response = await api(a, '/api/peers', { address: `127.0.0.1:${b.port}` });
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
});
after(async () => { await Promise.all([a?.close(), b?.close()]); await fsp.rm(dir, { recursive: true, force: true }); });
test('设备回应超过五秒仍可配置，发送前重新检查不会提前判定离线', async () => {
  const slow = await createApp({ port: 0, dataDir: path.join(dir, 'slow-client') });
  const id = crypto.randomUUID(), token = crypto.randomBytes(32).toString('hex');
  let received = false;
  const remote = http.createServer((req, res) => {
    if (req.url === '/peer/info') {
      const delay = setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ protocol: 'landrop-v1', id, token, name: '慢速回应设备', platform: 'win32', port: remote.address().port, enabled: true }));
      }, 5200);
      res.once('close', () => clearTimeout(delay));
    } else if (req.url === '/peer/request') {
      received = true; res.setHeader('Content-Type', 'application/json');
      req.resume(); req.once('end', () => res.end(JSON.stringify({ id: crypto.randomUUID() })));
    } else { res.writeHead(404); res.end('{}'); }
  });
  try {
    await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
    const response = await api(slow, '/api/peers', { address: `127.0.0.1:${remote.address().port}` });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    assert.equal(slow.state().peers[0].online, true);
    const outgoing = await slow.sendText(id, '慢速网络也可以发送');
    assert.equal(outgoing.status, 'completed', outgoing.error);
    assert.equal(received, true);
  } finally {
    await slow.close(); remote.closeAllConnections();
    await new Promise(resolve => remote.close(resolve));
  }
});

test('手动配置设备，本机管理接口不对其他来源开放', async () => {
  assert.equal(a.state().peers[0].name, '电脑 B');
  assert.equal(a.state().peers[0].token, undefined);
  const unauth = await fetch(`http://127.0.0.1:${b.port}/api/settings`, { method: 'POST', body: '{}' });
  assert.equal(unauth.status, 403);
  const foreign = await fetch(`http://127.0.0.1:${b.port}/api/state`, { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(foreign.status, 403);
  const remote = await fetch(`http://127.0.0.1:${b.port}/peer/request`, { method: 'POST', body: '{}' });
  assert.equal(remote.status, 403);
});
test('两端必须互相配置，配置后双向文字直接接收', async () => {
  const denied = await a.sendText(b.info().id, '尚未配置时不得接收');
  assert.equal(denied.status, 'failed'); assert.match(denied.error, /互相添加/);
  assert.equal(b.state().transfers.length, 0);
  assert.equal((await api(b, '/api/peers', { address: `127.0.0.1:${a.port}` })).status, 200);
  const text = '你好 👋\nhttps://example.com <script>';
  assert.equal((await a.sendText(b.info().id, text)).status, 'completed');
  assert.equal(b.state().transfers.find(j => j.text === text).status, 'completed');
  assert.ok(!b.state().transfers.some(j => j.status === 'pending'));
  assert.equal((await b.sendText(a.info().id, '双向互传 ✓')).status, 'completed');
});
test('局域网传输开关阻止发送和接收', async () => {
  await api(b, '/api/settings', { enabled: false });
  const disabled = await a.sendText(b.info().id, '关闭时不得接收');
  assert.equal(disabled.status, 'failed'); assert.match(disabled.error, /关闭局域网/);
  assert.equal((await api(b, '/api/text', { peerId: a.info().id, text: '不得发送' })).status, 403);
  await api(b, '/api/settings', { enabled: true });
});
test('流式发送二进制、SHA-256 校验及同名文件保留', async () => {
  const content = crypto.randomBytes(2 * 1024 * 1024 + 37), file = path.join(dir, '测试图片.png');
  await fsp.writeFile(file, content);
  for (let i = 0; i < 2; i++) {
    const outgoing = await a.sendLocalFile(b.info().id, file);
    assert.equal(outgoing.status, 'completed', outgoing.error);
    const incoming = b.state().transfers.filter(j => j.kind === 'file' && j.status === 'completed').at(-1);
    assert.deepEqual(await fsp.readFile(incoming.path), content);
    assert.equal(incoming.sha256, crypto.createHash('sha256').update(content).digest('hex'));
    assert.equal(path.basename(incoming.path), i ? '测试图片 (1).png' : '测试图片.png');
  }
});
test('浏览器上传与空文件可以成功接收', async () => {
  const response = await fetch(`http://127.0.0.1:${a.port}/api/file?${new URLSearchParams({ peerId: b.info().id, name: '空文件.txt', size: '0' })}`, { method: 'POST', headers: { 'X-App-Token': a.state().uiToken }, body: Buffer.alloc(0) });
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  const content = Buffer.from('浏览器上传 ✓');
  const upload = await fetch(`http://127.0.0.1:${a.port}/api/file?${new URLSearchParams({ peerId: b.info().id, name: '../hello.txt', size: String(content.length) })}`, { method: 'POST', headers: { 'X-App-Token': a.state().uiToken }, body: content });
  assert.equal(upload.status, 200, JSON.stringify(await upload.json()));
  const received = b.state().transfers.filter(j => j.name === '.._hello.txt').at(-1);
  assert.equal(path.dirname(received.path), b.state().settings.receiveDir);
  assert.deepEqual(await fsp.readFile(received.path), content);
  const headers = await api(b, `/api/download/${received.id}`, undefined, 'HEAD');
  assert.equal(headers.status, 200);
  assert.equal(Number(headers.headers.get('content-length')), content.length);
  const download = await fetch(`http://127.0.0.1:${b.port}/api/download/${received.id}?token=${b.state().uiToken}`);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), content);
});
test('传输中取消会同步结束接收并清理临时文件', async () => {
  const upload = http.request({ hostname: '127.0.0.1', port: a.port, path: `/api/file?${new URLSearchParams({ peerId: b.info().id, name: 'cancel.bin', size: '10000' })}`, method: 'POST', headers: { 'X-App-Token': a.state().uiToken, 'Content-Length': 10000 } });
  upload.on('error', () => {}); upload.write(Buffer.alloc(100));
  try {
    const incoming = await waitFor(() => b.state().transfers.find(j => j.name === 'cancel.bin' && j.status === 'transferring'));
    const outgoing = a.state().transfers.find(j => j.name === 'cancel.bin');
    await api(a, '/api/cancel', { id: outgoing.id });
    await waitFor(() => a.state().transfers.find(j => j.id === outgoing.id).status === 'cancelled');
    await waitFor(() => ['failed', 'cancelled'].includes(b.state().transfers.find(j => j.id === incoming.id).status));
    await waitFor(async () => !(await fsp.readdir(b.state().settings.receiveDir)).some(f => f.startsWith('cancel.bin')));
  } finally { upload.destroy(); }
});
test('不完整上传不保存半个文件，恶意文件名不能越出目录', async () => {
  assert.equal(safeName('../../CON.txt'), '.._.._CON.txt');
  assert.equal(safeName('CON.txt'), 'file_CON.txt');
  const response = await fetch(`http://127.0.0.1:${b.port}/peer/request`, { method: 'POST', headers: { 'X-Lan-Token': b.info().token, 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: a.info(), kind: 'file', name: 'bad.bin', size: 10 }) });
  const job = await response.json();
  const wrong = await fetch(`http://127.0.0.1:${b.port}/peer/upload/${job.id}`, { method: 'POST', headers: { 'X-Lan-Token': b.info().token }, body: Buffer.from('short') });
  assert.equal(wrong.status, 400);
  const files = await fsp.readdir(b.state().settings.receiveDir);
  assert.ok(!files.some(f => f === 'bad.bin' || f.endsWith('.part')));
});
test('传输途中断线会清理临时文件和占位文件', async () => {
  const prepared = await fetch(`http://127.0.0.1:${b.port}/peer/request`, { method: 'POST', headers: { 'X-Lan-Token': b.info().token, 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: a.info(), kind: 'file', name: 'interrupted.bin', size: 10000 }) });
  const { id } = await prepared.json();
  const upload = http.request({ hostname: '127.0.0.1', port: b.port, path: `/peer/upload/${id}`, method: 'POST', headers: { 'X-Lan-Token': b.info().token, 'Content-Length': 10000 } });
  upload.on('error', () => {});
  upload.write(Buffer.alloc(100));
  await waitFor(() => b.state().transfers.find(j => j.id === id)?.status === 'transferring');
  upload.destroy();
  await waitFor(() => b.state().transfers.find(j => j.id === id)?.status === 'failed');
  const files = await fsp.readdir(b.state().settings.receiveDir);
  assert.ok(!files.some(f => f.startsWith('interrupted.bin') || f.endsWith('.part')));
});
test('设备配置与历史重启后保留，凭证刷新且清空记录不删除文件', async () => {
  await api(b, '/api/settings', { name: '工作电脑 B' });
  const completed = b.state().transfers.find(j => j.path);
  const oldPort = b.port, oldToken = b.info().token;
  await b.close();
  b = await createApp({ port: oldPort, dataDir: path.join(dir, 'b') });
  assert.equal(b.state().self.name, '工作电脑 B');
  assert.ok(b.state().peers.find(p => p.id === a.info().id));
  assert.notEqual(b.info().token, oldToken);
  assert.equal((await a.sendText(b.info().id, '重启后仍可发送')).status, 'completed');
  assert.equal((await b.sendText(a.info().id, '重启后仍可回传')).status, 'completed');
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'b', 'state.json'), 'utf8'));
  assert.ok(saved.peers.length); assert.equal(saved.peers[0].token, undefined);
  assert.ok(b.state().transfers.find(j => j.id === completed.id));
  await api(b, '/api/history', undefined, 'DELETE');
  assert.equal(b.state().transfers.length, 0);
  assert.ok((await fsp.stat(completed.path)).isFile());
});
test('页面断开重连以及开始传输时退出，不写入已关闭的连接', async () => {
  const c = await createApp({ port: 0, name: '退出测试 C', dataDir: path.join(dir, 'c') });
  const d = await createApp({ port: 0, name: '退出测试 D', dataDir: path.join(dir, 'd') });
  const connections = [];
  function subscribe() {
    return new Promise((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${c.port}/api/events?token=${c.state().uiToken}`, response => {
        connections.push(response);
        response.once('data', () => resolve(response));
        response.on('data', () => {});
        response.on('error', () => {});
      });
      request.on('error', reject);
    });
  }
  try {
    const first = await subscribe(); first.destroy();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await api(c, '/api/settings', { name: '断开后仍正常' })).status, 200);
    const second = await subscribe();
    assert.equal((await api(c, '/api/peers', { address: `127.0.0.1:${d.port}` })).status, 200);
    await api(d, '/api/peers', { address: `127.0.0.1:${c.port}` });
    const outgoing = c.sendText(d.info().id, '退出时取消这条消息');
    await c.close();
    assert.equal((await outgoing).status, 'cancelled');
    await waitFor(() => second.destroyed);
    await waitFor(() => d.state().transfers.every(j => j.status !== 'pending'));
    // Allow any delayed stream error to surface as a node:test failure.
    await new Promise(resolve => setTimeout(resolve, 60));
  } finally { for (const connection of connections) connection.destroy(); await Promise.all([c.close(), d.close()]); }
});
test('接收文件途中退出会等到不完整文件清理结束', async () => {
  const app = await createApp({ port: 0, dataDir: path.join(dir, 'exit-during-upload') });
  let upload;
  try {
    assert.equal((await api(app, '/api/peers', { address: `127.0.0.1:${a.port}` })).status, 200);
    const prepared = await fetch(`http://127.0.0.1:${app.port}/peer/request`, { method: 'POST', headers: { 'X-Lan-Token': app.info().token, 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: a.info(), kind: 'file', name: 'exit.bin', size: 10000 }) });
    const { id } = await prepared.json();
    upload = http.request({ hostname: '127.0.0.1', port: app.port, path: `/peer/upload/${id}`, method: 'POST', headers: { 'X-Lan-Token': app.info().token, 'Content-Length': 10000 } });
    upload.on('error', () => {}); upload.write(Buffer.alloc(100));
    await waitFor(() => app.state().transfers.find(j => j.id === id)?.status === 'transferring');
    await app.close();
    assert.deepEqual(await fsp.readdir(app.state().settings.receiveDir), []);
    assert.equal(app.state().transfers.find(j => j.id === id).status, 'cancelled');
  } finally { upload?.destroy(); await app.close(); }
});

test('逐条删除文字仅作用于本机，立即释放记录并在重启后保持删除', async () => {
  const c = await createApp({ port: 0, dataDir: path.join(dir, 'delete-text-c') });
  let d = await createApp({ port: 0, dataDir: path.join(dir, 'delete-text-d') });
  try {
    await api(c, '/api/peers', { address: `127.0.0.1:${d.port}` });
    await api(d, '/api/peers', { address: `127.0.0.1:${c.port}` });
    const secret = '待删除的文字内容 📝';
    const sent = await c.sendText(d.info().id, secret);
    await c.sendText(d.info().id, '保留的另一条消息');
    const received = d.state().transfers.find(job => job.text === secret);
    const unauthorized = await fetch(`http://127.0.0.1:${d.port}/api/history/${received.id}`, { method: 'DELETE' });
    assert.equal(unauthorized.status, 403);
    assert.equal((await api(d, `/api/history/${received.id}`, undefined, 'DELETE')).status, 200);
    assert.ok(!d.state().transfers.some(job => job.text === secret));
    assert.ok(c.state().transfers.some(job => job.id === sent.id), '对方的文字记录应保留');
    const saved = await fsp.readFile(path.join(dir, 'delete-text-d', 'state.json'), 'utf8');
    assert.ok(!saved.includes(secret));
    assert.equal((await api(d, `/api/history/${received.id}`, undefined, 'DELETE')).status, 404);
    const oldPort = d.port; await d.close();
    d = await createApp({ port: oldPort, dataDir: path.join(dir, 'delete-text-d') });
    assert.ok(!d.state().transfers.some(job => job.text === secret));
    assert.ok(d.state().transfers.some(job => job.text === '保留的另一条消息'));
    assert.equal((await api(c, `/api/history/${sent.id}`, undefined, 'DELETE')).status, 200);
  } finally { await Promise.all([c.close(), d.close()]); }
});

test('删除记录不会删除文件，尚未结束的传输不能删除记录', async () => {
  const c = await createApp({ port: 0, dataDir: path.join(dir, 'delete-file-c') });
  const d = await createApp({ port: 0, dataDir: path.join(dir, 'delete-file-d') });
  try {
    await api(c, '/api/peers', { address: `127.0.0.1:${d.port}` });
    await api(d, '/api/peers', { address: `127.0.0.1:${c.port}` });
    const filename = path.join(dir, '保留文件.txt'); await fsp.writeFile(filename, '文件内容仍然保留');
    assert.equal((await c.sendLocalFile(d.info().id, filename)).status, 'completed');
    const received = d.state().transfers.find(job => job.kind === 'file');
    assert.equal((await api(d, `/api/history/${received.id}`, undefined, 'DELETE')).status, 200);
    assert.equal(await fsp.readFile(received.path, 'utf8'), '文件内容仍然保留');
    const prepared = await fetch(`http://127.0.0.1:${d.port}/peer/request`, { method: 'POST', headers: { 'X-Lan-Token': d.info().token, 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: c.info(), kind: 'file', name: '尚未结束.txt', size: 10 }) });
    const { id } = await prepared.json();
    assert.equal((await api(d, `/api/history/${id}`, undefined, 'DELETE')).status, 409);
    assert.ok(d.state().transfers.some(job => job.id === id && job.status === 'ready'));
    await api(d, '/api/cancel', { id });
  } finally { await Promise.all([c.close(), d.close()]); }
});

test('移除设备后拒绝该设备，配置文件同步移除地址', async () => {
  await api(b, `/api/peers/${a.info().id}`, undefined, 'DELETE');
  assert.equal(b.state().peers.length, 0);
  const denied = await a.sendText(b.info().id, '移除后不得接收');
  assert.equal(denied.status, 'failed'); assert.match(denied.error, /互相添加/);
  assert.equal(JSON.parse(await fsp.readFile(path.join(dir, 'b', 'state.json'), 'utf8')).peers.length, 0);
});
