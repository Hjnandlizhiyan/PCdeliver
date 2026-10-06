const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { networkAddresses, privateAddress, connectionError } = require('./network');
const { readState } = require('../desktop/storage');

const MAX_FILE = 20 * 1024 ** 3;
const INFO_TIMEOUT = 30000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
function safeName(name) {
  const cleaned = String(name).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 180);
  return !cleaned || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(cleaned) ? `file_${cleaned || 'untitled'}` : cleaned;
}
async function jsonBody(req, limit = 128 * 1024) {
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > limit) throw new Error('内容过大'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
function reply(res, code, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function isLocal(req) { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress); }
function requestJson(peer, route, data, signal, method = 'POST') {
  return new Promise((resolve, reject) => {
    let connected = false;
    const fail = error => reject(Object.assign(new Error(connectionError(error, connected), { cause: error }), { code: error.code }));
    const body = data === undefined ? null : Buffer.from(JSON.stringify(data));
    const req = http.request({ hostname: peer.address, port: peer.port, path: route, method, signal, headers: { ...(peer.token ? { 'X-Lan-Token': peer.token } : {}), ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}) } }, async res => {
      try { const result = await jsonBody(res); if (res.statusCode >= 400) throw Object.assign(new Error(result.error || '对方设备拒绝了请求'), { code: result.errorCode || 'PEER_REQUEST_FAILED' }); resolve(result); } catch (err) { fail(err); }
    });
    req.on('socket', socket => { connected = !socket.connecting; if (socket.connecting) socket.once('connect', () => { connected = true; }); });
    req.setTimeout(100000, () => req.destroy(Object.assign(new Error('回应超时'), { code: 'ETIMEDOUT' })));
    req.on('error', fail); req.end(body);
  });
}
async function createApp(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, '..', '.landrop');
  await fsp.mkdir(dataDir, { recursive: true });
  const saved = await readState(path.join(dataDir, 'state.json')) || {};
  const config = { id: saved.id || crypto.randomUUID(), name: options.name || saved.name || os.hostname(), receiveDir: options.receiveDir || saved.receiveDir || path.join(dataDir, 'received'), enabled: saved.enabled !== false, language: saved.language === 'en' ? 'en' : 'zh-CN' };
  await fsp.mkdir(config.receiveDir, { recursive: true });
  const token = crypto.randomBytes(32).toString('hex'), uiToken = crypto.randomBytes(32).toString('hex');
  const peers = new Map(), clients = new Set(), active = new Map(), jobs = new Map(), operations = new Set();
  for (const p of saved.peers || []) {
    if (typeof p.id === 'string' && typeof p.name === 'string' && privateAddress(p.address) && Number.isInteger(p.port) && p.port > 0 && p.port <= 65535) peers.set(p.id, { id: p.id, name: p.name, address: p.address, port: p.port, platform: p.platform, lastSeen: 0, online: false });
  }
  for (const j of (saved.history || []).slice(-200)) jobs.set(j.id, { ...j, status: TERMINAL.has(j.status) ? j.status : 'failed', ...(TERMINAL.has(j.status) ? {} : { error: '应用退出，传输已中断' }) });
  let port = 0, warning = '', persistChain = Promise.resolve(), closing = false;
  const shutdown = new AbortController();
  function readPeerInfo(peer, signal) {
    const signals = [shutdown.signal, AbortSignal.timeout(INFO_TIMEOUT)];
    if (signal) signals.push(signal);
    return requestJson(peer, '/peer/info', undefined, AbortSignal.any(signals), 'GET');
  }
  function info() { return { protocol: 'landrop-v1', id: config.id, name: config.name, platform: process.platform, port, token, enabled: config.enabled }; }
  function state() {
    const interfaces = networkAddresses();
    return { self: { id: config.id, name: config.name, platform: process.platform, port, addresses: interfaces.map(x => x.address), interfaces }, settings: { receiveDir: config.receiveDir, enabled: config.enabled, language: config.language }, peers: [...peers.values()].map(({ token: _, checking: __, ...p }) => p), transfers: [...jobs.values()], warning, uiToken };
  }
  function persist() {
    const contents = JSON.stringify({ ...config, peers: [...peers.values()].map(({ id, name, address, port, platform }) => ({ id, name, address, port, platform })), history: [...jobs.values()].filter(j => TERMINAL.has(j.status)).slice(-200) }, null, 2);
    persistChain = persistChain.then(() => fsp.writeFile(path.join(dataDir, 'state.tmp'), contents).then(() => fsp.rename(path.join(dataDir, 'state.tmp'), path.join(dataDir, 'state.json')))).catch(err => { warning = `保存记录失败：${err.message}`; });
    return persistChain;
  }
  function emit() {
    if (closing) return;
    const event = `data: ${JSON.stringify(state())}\n\n`;
    for (const c of clients) writeEvent(c, event);
  }
  function writeEvent(client, event) {
    if (client.destroyed || client.writableEnded || client.closed) { clients.delete(client); return; }
    try { client.write(event); } catch { clients.delete(client); client.destroy(); }
  }
  function beginOperation() {
    let complete;
    const promise = new Promise(resolve => { complete = resolve; });
    operations.add(promise);
    return () => { operations.delete(promise); complete(); };
  }
  function update(job, fields) {
    Object.assign(job, fields, { updatedAt: Date.now() });
    emit(); if (TERMINAL.has(job.status)) { const control = active.get(job.id); clearTimeout(control?.expiry); clearTimeout(control?.timer); active.delete(job.id); persist(); }
  }
  function newJob(fields) {
    const job = { id: crypto.randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), progress: 0, bytes: 0, speed: 0, ...fields };
    jobs.set(job.id, job);
    if (jobs.size > 250) { const old = [...jobs.values()].find(j => TERMINAL.has(j.status)); if (old) jobs.delete(old.id); }
    emit(); return job;
  }
  function rememberPeer(peer) {
    for (const [id, p] of peers) if (id !== peer.id && p.address === peer.address && p.port === peer.port) peers.delete(id);
    peers.set(peer.id, { ...peer, lastSeen: Date.now(), online: true }); emit();
  }
  async function refreshPeer(peer, signal) {
    try {
      const remote = await readPeerInfo(peer, signal);
      if (remote.protocol !== 'landrop-v1' || remote.id !== peer.id || !/^[a-f0-9]{64}$/.test(remote.token) || typeof remote.name !== 'string') throw new Error('设备身份已改变，请重新添加这台设备');
      if (closing) throw new Error('软件正在退出');
      const platform = typeof remote.platform === 'string' ? remote.platform : 'unknown';
      const platformChanged = peer.platform !== platform;
      Object.assign(peer, { token: remote.token, name: remote.name.slice(0, 40), platform, enabled: remote.enabled !== false, lastSeen: Date.now(), online: true, error: '' });
      if (platformChanged) await persist();
      emit(); return peer;
    } catch (err) {
      peer.online = false; peer.error = err.message; emit(); throw err;
    }
  }
  async function refreshPeers() {
    await Promise.allSettled([...peers.values()].filter(p => !p.checking).map(async peer => { peer.checking = true; try { await refreshPeer(peer); } finally { peer.checking = false; } }));
  }
  function progressMeter(job, signal) {
    let total = 0, lastBytes = 0, lastTime = Date.now(); const hash = crypto.createHash('sha256');
    const stream = new Transform({ transform(chunk, _, callback) {
      if (signal?.aborted) return callback(new Error('传输已取消'));
      total += chunk.length;
      if (total > job.size) return callback(new Error('文件长度超过声明大小'));
      hash.update(chunk);
      const now = Date.now();
      if (now - lastTime >= 160 || total === job.size) { update(job, { bytes: total, progress: job.size ? Math.min(99, Math.round(total / job.size * 100)) : 0, speed: Math.round((total - lastBytes) * 1000 / Math.max(1, now - lastTime)) }); lastTime = now; lastBytes = total; }
      callback(null, chunk);
    } });
    return { stream, hash, get total() { return total; } };
  }
  async function send(peerId, meta, source) {
    if (closing || !config.enabled) throw new Error('请在偏好设置中开启局域网传输');
    const peer = peers.get(peerId);
    if (!peer) throw new Error('请先选择在线设备');
    if (meta.kind === 'file' && (!Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > MAX_FILE)) throw new Error('单个文件上限为 20 GB');
    if (meta.kind === 'text' && (typeof meta.text !== 'string' || !meta.text.trim() || Buffer.byteLength(meta.text) > 100000)) throw new Error('文字不能为空，且不得超过 100 KB');
    const job = newJob({ direction: 'outgoing', kind: meta.kind, name: meta.kind === 'text' ? '文字消息' : safeName(meta.name), size: meta.kind === 'text' ? Buffer.byteLength(meta.text) : meta.size, text: meta.text, peerName: peer.name, peerId, status: 'connecting' });
    const controller = new AbortController(); const control = { controller }; active.set(job.id, control);
    const finish = beginOperation();
    try {
      await refreshPeer(peer, controller.signal);
      if (!peer.enabled) throw new Error('对方已关闭局域网传输，请在对方软件的偏好设置中开启');
      const prepared = await requestJson(peer, '/peer/request', { sender: info(), kind: job.kind, name: job.name, size: job.size, text: meta.text }, controller.signal);
      control.remoteId = prepared.id; control.peer = peer;
      if (controller.signal.aborted) throw new Error('传输已取消');
      if (job.kind === 'text') { update(job, { status: 'completed', progress: 100, bytes: job.size }); return job; }
      update(job, { status: 'transferring' });
      const readable = typeof source === 'function' ? source() : source;
      const meter = progressMeter(job, controller.signal);
      const result = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: peer.address, port: peer.port, path: `/peer/upload/${prepared.id}`, method: 'POST', signal: controller.signal, headers: { 'X-Lan-Token': peer.token, 'Content-Type': 'application/octet-stream', 'Content-Length': job.size } }, async res => {
          try { const result = await jsonBody(res); if (res.statusCode >= 400) throw new Error(result.error || '接收失败'); resolve(result); } catch (err) { reject(err); }
        });
        req.setTimeout(60000, () => req.destroy(new Error('传输超时')));
        req.on('error', reject);
        pipeline(readable, meter.stream, req, { signal: controller.signal }).catch(reject);
      });
      if (meter.total !== job.size || result.sha256 !== meter.hash.digest('hex')) throw new Error('文件完整性校验失败');
      update(job, { status: 'completed', progress: 100, bytes: job.size, sha256: result.sha256 });
    } catch (err) {
      if (control.remoteId) requestJson(peer, `/peer/request/${control.remoteId}`, undefined, undefined, 'DELETE').catch(() => {});
      update(job, { status: controller.signal.aborted ? 'cancelled' : ['TRANSFER_REJECTED', 'ECONNREFUSED'].includes(err.code) ? 'rejected' : 'failed', error: controller.signal.aborted ? '传输已取消' : err.message });
    } finally { finish(); }
    return job;
  }
  async function sendLocalFile(peerId, filePath) {
    const stat = await fsp.stat(filePath); if (!stat.isFile()) throw new Error('请选择文件；文件夹请先压缩');
    return send(peerId, { kind: 'file', name: path.basename(filePath), size: stat.size }, () => fs.createReadStream(filePath));
  }
  async function reservePath(name) {
    const ext = path.extname(name), stem = path.basename(name, ext);
    for (let i = 0; i < 10000; i++) {
      const destination = path.join(config.receiveDir, i ? `${stem} (${i})${ext}` : name);
      try { const handle = await fsp.open(destination, 'wx'); await handle.close(); return destination; } catch (err) { if (err.code !== 'EEXIST') throw err; }
    }
    throw new Error('同名文件过多');
  }
  function cancel(id) {
    const job = jobs.get(id), control = active.get(id);
    if (!job || TERMINAL.has(job.status)) return;
    control?.controller?.abort(); control?.request?.destroy(new Error('传输已取消')); control?.resolve?.(false);
    update(job, { status: 'cancelled', error: '传输已取消' });
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(req.url, 'http://localhost'); const route = url.pathname;
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return reply(res, 403, { error: '请求来源不受信任' });
      if (route.startsWith('/peer/')) {
        const remote = req.socket.remoteAddress.replace('::ffff:', '');
        if (!privateAddress(remote)) return reply(res, 403, { error: '只允许局域网设备连接' });
        if (route === '/peer/info' && req.method === 'GET') return reply(res, 200, info());
        if (req.headers['x-lan-token'] !== token) return reply(res, 403, { error: '设备凭证已更新，请重新连接' });
        if (route === '/peer/request' && req.method === 'POST') {
          if (!config.enabled) return reply(res, 403, { error: '对方已关闭局域网传输' });
          if (active.size >= 50) return reply(res, 429, { error: '接收队列已满' });
          const data = await jsonBody(req);
          if (!['file', 'text'].includes(data.kind) || !Number.isSafeInteger(data.size) || data.size < 0 || data.size > MAX_FILE || !data.sender || typeof data.sender.name !== 'string') return reply(res, 400, { error: '无效的传输请求' });
          if (data.kind === 'text' && (typeof data.text !== 'string' || !data.text.trim() || Buffer.byteLength(data.text) > 100000 || Buffer.byteLength(data.text) !== data.size)) return reply(res, 400, { error: '无效的文字消息' });
          const configured = peers.get(data.sender.id);
          if (!configured || configured.address !== remote || configured.port !== data.sender.port) return reply(res, 403, { error: '对方尚未配置这台电脑，请在两台软件里互相添加 IP 和端口' });
          const job = newJob({ direction: 'incoming', kind: data.kind, name: data.kind === 'text' ? '文字消息' : safeName(data.name), size: data.size, text: data.text, peerName: configured.name, peerId: data.sender.id, status: 'ready' });
          if (job.kind === 'text') update(job, { status: 'completed', progress: 100, bytes: job.size });
          else active.set(job.id, { senderAddress: remote, expiry: setTimeout(() => { if (job.status === 'ready') update(job, { status: 'failed', error: '发送方未开始传输' }); }, 60000) });
          return reply(res, 200, { id: job.id });
        }
        if (route.startsWith('/peer/request/') && req.method === 'DELETE') { cancel(route.split('/').pop()); return reply(res, 200, { ok: true }); }
        if (route.startsWith('/peer/upload/') && req.method === 'POST') {
          const job = jobs.get(route.split('/').pop());
          if (!job || job.status !== 'ready') return reply(res, 409, { error: '接收请求已过期' });
          if (Number(req.headers['content-length']) !== job.size) { cancel(job.id); return reply(res, 400, { error: '文件大小不匹配' }); }
          const control = active.get(job.id);
          if (control.senderAddress !== remote) return reply(res, 403, { error: '上传设备与已配置的发送方不一致' });
          clearTimeout(control.expiry); control.request = req;
          const finish = beginOperation();
          update(job, { status: 'transferring' });
          let destination, temporary; const meter = progressMeter(job);
          try {
            destination = await reservePath(job.name); temporary = `${destination}.${job.id}.part`;
            await pipeline(req, meter.stream, fs.createWriteStream(temporary, { flags: 'wx' }));
            if (meter.total !== job.size || job.status === 'cancelled') throw new Error('文件传输未完成');
            const sha256 = meter.hash.digest('hex');
            await fsp.rename(temporary, destination);
            update(job, { status: 'completed', progress: 100, bytes: job.size, path: destination, sha256 });
            return reply(res, 200, { ok: true, sha256 });
          } catch (err) {
            if (temporary) await fsp.rm(temporary, { force: true }).catch(() => {});
            if (destination) await fsp.rm(destination, { force: true }).catch(() => {});
            if (job.status !== 'cancelled') update(job, { status: 'failed', error: '传输中断，未保存不完整文件' });
            return reply(res, 500, { error: err.message });
          } finally { finish(); }
        }
        return reply(res, 404, { error: '接口不存在' });
      }
      if (!isLocal(req) || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return reply(res, 403, { error: '请在本机打开应用；其他电脑需要运行自己的实例' });
      if (route === '/api/state' && req.method === 'GET') return reply(res, 200, state());
      if (route === '/api/events' && req.method === 'GET') {
        if (url.searchParams.get('token') !== uiToken) return reply(res, 403, { error: '无效凭证' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        res.on('close', () => clients.delete(res));
        res.on('error', () => { clients.delete(res); res.destroy(); });
        clients.add(res); writeEvent(res, `data: ${JSON.stringify(state())}\n\n`); return;
      }
      if (route.startsWith('/api/')) {
        if (req.headers['x-app-token'] !== uiToken && !(route.startsWith('/api/download/') && req.method === 'GET' && url.searchParams.get('token') === uiToken)) return reply(res, 403, { error: '无效凭证' });
        if (route === '/api/peers' && req.method === 'POST') {
          const { address } = await jsonBody(req);
          const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(String(address).trim());
          if (!match || !privateAddress(match[1]) || (match[2] && (+match[2] < 1 || +match[2] > 65535))) return reply(res, 400, { error: '请输入局域网 IPv4 地址，例如 192.168.1.8:45878' });
          const peer = { address: match[1], port: Number(match[2] || 45878) };
          const remote = await readPeerInfo(peer);
          if (remote.protocol !== 'landrop-v1' || !/^[a-f0-9]{64}$/.test(remote.token) || typeof remote.name !== 'string' || typeof remote.id !== 'string') throw new Error('该地址没有运行局域传送');
          if (remote.id === config.id) throw new Error('这是当前电脑，请添加另一台设备');
          rememberPeer({ ...remote, ...peer }); await persist(); return reply(res, 200, { ok: true, id: remote.id });
        }
        if (route.startsWith('/api/peers/') && req.method === 'DELETE') {
          const id = route.split('/').pop(); peers.delete(id);
          for (const job of jobs.values()) if (job.peerId === id && !TERMINAL.has(job.status)) cancel(job.id);
          await persist(); emit(); return reply(res, 200, { ok: true });
        }
        if (route === '/api/scan' && req.method === 'POST') { await refreshPeers(); return reply(res, 200, { ok: true }); }
        if (route === '/api/settings' && req.method === 'POST') {
          const data = await jsonBody(req);
          if (data.language !== undefined && !['zh-CN', 'en'].includes(data.language)) return reply(res, 400, { error: '不支持的界面语言' });
          const languageChanged = data.language !== undefined && data.language !== config.language;
          if (data.language !== undefined) config.language = data.language;
          if (typeof data.name === 'string') config.name = data.name.trim().slice(0, 40) || os.hostname();
          if (typeof data.enabled === 'boolean') {
            config.enabled = data.enabled;
            if (!config.enabled) for (const [id] of active) cancel(id);
          }
          await persist(); emit();
          if (languageChanged) options.onLanguageChanged?.(config.language);
          return reply(res, 200, { ok: true });
        }
        if (route === '/api/cancel' && req.method === 'POST') { const { id } = await jsonBody(req); cancel(id); return reply(res, 200, { ok: true }); }
        if (route === '/api/text' && req.method === 'POST') {
          if (!config.enabled) return reply(res, 403, { error: '请在偏好设置中开启局域网传输' });
          const { peerId, text } = await jsonBody(req);
          if (!peers.has(peerId) || typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 100000) return reply(res, 400, { error: '请选择设备并输入文字，文字最多 100 KB' });
          send(peerId, { kind: 'text', text }).catch(() => {}); return reply(res, 202, { ok: true });
        }
        if (route === '/api/file' && req.method === 'POST') {
          if (!config.enabled) return reply(res, 403, { error: '请在偏好设置中开启局域网传输' });
          if (!peers.has(url.searchParams.get('peerId'))) return reply(res, 400, { error: '请先选择设备' });
          const result = await send(url.searchParams.get('peerId'), { kind: 'file', name: url.searchParams.get('name'), size: Number(url.searchParams.get('size')) }, req);
          return reply(res, result.status === 'completed' ? 200 : 409, result.status === 'completed' ? { ok: true } : { error: result.error || '传输未完成' });
        }
        if (route === '/api/history' && req.method === 'DELETE') { for (const [id, job] of jobs) if (TERMINAL.has(job.status)) jobs.delete(id); await persist(); emit(); return reply(res, 200, { ok: true }); }
        if (route.startsWith('/api/history/') && req.method === 'DELETE') {
          const id = route.slice('/api/history/'.length), job = jobs.get(id);
          if (!job) return reply(res, 404, { error: '这条记录已经不存在' });
          if (!TERMINAL.has(job.status)) return reply(res, 409, { error: '传输尚未结束，请先取消传输' });
          jobs.delete(id); await persist(); emit(); return reply(res, 200, { ok: true });
        }
        if (route.startsWith('/api/download/') && ['GET', 'HEAD'].includes(req.method)) {
          const job = jobs.get(route.split('/').pop());
          if (!job?.path || job.status !== 'completed') return reply(res, 404, { error: '文件不存在' });
          const stat = await fsp.stat(job.path);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(job.name)}` });
          if (req.method === 'HEAD') res.end(); else await pipeline(fs.createReadStream(job.path), res); return;
        }
        return reply(res, 404, { error: '接口不存在' });
      }
      if (req.method !== 'GET') return reply(res, 405, { error: '请求方法不支持' });
      const assets = { '/': 'index.html', '/app.js': 'app.js', '/i18n.js': 'i18n.js', '/community-links.js': 'community-links.js', '/community.js': 'community.js', '/styles.css': 'styles.css', '/mark.svg': 'mark.svg', '/logo.png': 'logo.png', '/mascot-received.png': 'mascot-received.png', '/mascot-sent.png': 'mascot-sent.png' };
      if (!assets[route]) return reply(res, 404, { error: '页面不存在' });
      const file = path.join(__dirname, '..', 'public', assets[route]);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
      await pipeline(fs.createReadStream(file), res);
    } catch (err) { if (!res.headersSent) reply(res, 400, { error: err.name === 'AbortError' || err.name === 'TimeoutError' ? '连接超时，请检查 IP、端口和防火墙' : err.message }); else res.destroy(); }
  });
  server.requestTimeout = 0;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port === undefined ? 45878 : options.port, '0.0.0.0', resolve); });
  port = server.address().port;
  refreshPeers().catch(() => {});
  const tick = setInterval(() => {
    if (closing) return;
    refreshPeers().catch(() => {});
    for (const c of clients) writeEvent(c, ': keepalive\n\n');
  }, 5000); tick.unref();
  await persist();
  return {
    port, state, info, sendLocalFile, sendText: (peerId, text) => send(peerId, { kind: 'text', text }),
    hasActiveTransfers: () => active.size > 0 || operations.size > 0,
    getReceivedPath: id => jobs.get(id)?.status === 'completed' ? jobs.get(id)?.path : undefined,
    async setReceiveDir(directory) { await fsp.mkdir(directory, { recursive: true }); config.receiveDir = directory; await persist(); emit(); },
    async close() {
      if (closing) return; closing = true;
      shutdown.abort();
      clearInterval(tick);
      for (const [id] of active) cancel(id);
      for (const c of clients) c.end();
      clients.clear();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await Promise.allSettled([...operations]);
      await persist();
    }
  };
}
module.exports = { createApp, safeName };
