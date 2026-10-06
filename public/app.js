const $ = id => document.getElementById(id);
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const terminal = new Set(['completed', 'failed', 'rejected', 'cancelled']);
let state, selectedPeer = '', selectedFiles = [], activeTab = 'files', currentPage = 'home', historyFilter = 'all', message = '', messageId = '', toastTimer, events;
const successNotices = new Map();
function dismissSuccess(direction) {
  clearTimeout(successNotices.get(direction)?.timer);
  successNotices.delete(direction); renderSuccessNotices();
}
function renderSuccessNotices() {
  $('success-notices').innerHTML = [...successNotices].map(([direction, notice]) => {
    const job = state.transfers.find(item => item.id === notice.jobId);
    if (!job) return '';
    const incoming = direction === 'incoming';
    const title = `${notice.count > 1 ? '' : job.kind === 'text' ? '文字' : '文件'}${incoming ? '接收' : '发送'}成功`;
    const action = job.kind === 'text' ? `<button class="text-button" data-message="${escapeHtml(job.id)}">查看文字${icon('arrow')}</button>`
      : incoming ? `<button class="text-button" data-file="${escapeHtml(job.id)}">${window.desktop ? '打开位置' : '下载文件'}${icon('folder')}</button>` : '';
    return `<section class="success-notice" data-success-direction="${direction}" role="status"><img src="/mascot-${incoming ? 'received' : 'sent'}.png" alt="${incoming ? '抱着文件开心微笑' : '眨眼点赞'}的局域传送少女"><div class="success-notice-content"><span class="success-eyebrow">${incoming ? '好好收到了！' : '顺利送达啦！'}</span><strong>${title}${notice.count > 1 ? ` · ${notice.count} 项` : ''}</strong><p>${incoming ? '来自' : '送达'} ${escapeHtml(job.peerName)}</p><small>${job.kind === 'text' ? '文字已保存到传输记录' : escapeHtml(job.name)}</small>${action}</div><button class="icon-button success-dismiss" data-dismiss-success="${direction}" aria-label="关闭${incoming ? '接收' : '发送'}成功提示">${icon('x')}</button></section>`;
  }).join('');
}
function showTransferSuccess(job) {
  const previous = successNotices.get(job.direction);
  clearTimeout(previous?.timer);
  const notice = { jobId: job.id, count: (previous?.count || 0) + 1 };
  notice.timer = setTimeout(() => dismissSuccess(job.direction), 10000);
  successNotices.set(job.direction, notice); renderSuccessNotices();
}
function toast(text, error = false) { $('toast').textContent = text; $('toast').classList.toggle('error', error); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4200); }
async function api(route, data, method = 'POST') {
  const response = await fetch(route, { method, headers: { 'X-App-Token': state.uiToken, 'Content-Type': 'application/json' }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '操作失败'); return result;
}
function size(bytes = 0) { if (bytes === 0) return '0 B'; const i = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024))); return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][i]}`; }
function platformName(platform) { return { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[platform] || '电脑'; }
function fileIcon(job) { return job.kind === 'text' ? 'text' : /\.(png|jpe?g|gif|webp|bmp|svg|heic)$/i.test(job.name) ? 'image' : 'file'; }
function showPage(page) {
  currentPage = page;
  const titles = { home: ['传输工作台', '让分享，近一点', '两台电脑都运行软件，手动配置后直接传输。'], devices: ['配置设备', '连接另一台电脑', '在两台软件里互相添加连接地址，配置会自动保存。'], history: ['传输记录', '分享的足迹', '查看传输进度，以及每一次成功送达的分享。'], settings: ['偏好设置', '按你的方式分享', '开启局域网传输，并设置这台电脑的接收目录。'] };
  for (const key of Object.keys(titles)) $(`${key}-view`).hidden = key !== page;
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.page === page));
  $('breadcrumb-title').textContent = titles[page][0];
  $('page-title').innerHTML = `${titles[page][1]}<span class="heading-dot">。</span>`;
  $('page-subtitle').textContent = titles[page][2];
  if (page === 'settings') { $('settings-name').value = state.self.name; $('lan-enabled').checked = state.settings.enabled; }
}
function changeTab(tab) {
  activeTab = tab; $('files-pane').hidden = tab !== 'files'; $('text-pane').hidden = tab === 'files'; $('clipboard-note').hidden = tab !== 'clipboard';
  document.querySelectorAll('.tab').forEach(el => { el.classList.toggle('active', el.dataset.tab === tab); el.setAttribute('aria-selected', String(el.dataset.tab === tab)); });
  updateSendButton();
}
function updateSendButton() { const online = state?.settings.enabled && state?.peers.some(p => p.id === selectedPeer && p.online && p.enabled !== false); $('send-button').disabled = !online || (activeTab === 'files' ? !selectedFiles.length : !$('text-content').value.trim()); }
function renderFiles() {
  $('file-list').hidden = !selectedFiles.length;
  $('file-list').innerHTML = selectedFiles.map((file, i) => `<div class="file-chip">${icon(/\.(png|jpe?g|gif|webp)$/i.test(file.name) ? 'image' : 'file')}<span title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span><button class="icon-button" data-remove-file="${i}" aria-label="移除 ${escapeHtml(file.name)}">${icon('x')}</button></div>`).join('');
  updateSendButton();
}
function addFiles(files) {
  let skipped = 0;
  for (const file of files) { if (file.size > 20 * 1024 ** 3) { skipped++; continue; } if (!selectedFiles.some(x => x.name === file.name && x.size === file.size && x.lastModified === file.lastModified)) selectedFiles.push(file); }
  if (selectedFiles.length) changeTab('files'); renderFiles(); if (skipped) toast(`${skipped} 个文件超过 20 GB 上限`, true);
}
async function chooseFiles() { if (window.desktop) { const files = await window.desktop.selectFiles(); for (const file of files) if (!selectedFiles.some(x => x.path === file.path)) selectedFiles.push(file); renderFiles(); } else $('file-input').click(); }
function choosePeer(id) { selectedPeer = id; $('target-device').value = id; renderPeers(); updateSendButton(); }
function peerCards(peers) {
  if (!peers.length) return `<div class="devices-empty"><span class="empty-radar">${icon('devices')}</span><div><strong>先配置你的另一台电脑</strong><p>两台电脑都运行局域传送，在“配置设备”中互相添加 IP 和端口。</p></div><button class="text-button" data-action="add-peer">手动配置${icon('arrow')}</button></div>`;
  return peers.map(peer => `<div class="peer-entry"><button class="peer-card ${peer.id === selectedPeer ? 'selected' : ''}" data-peer="${escapeHtml(peer.id)}" title="${escapeHtml(peer.error || '')}" ${!peer.online ? 'disabled' : ''}><span class="peer-avatar">${icon(peer.platform === 'darwin' ? 'laptop' : 'monitor')}</span><span class="peer-info"><strong title="${escapeHtml(peer.name)}">${escapeHtml(peer.name)}</strong><small>${escapeHtml(peer.address)}:${peer.port}</small><span class="online-label">${peer.online ? '<i class="status-dot"></i>' + (peer.enabled === false ? '传输已关闭 · ' : '在线 · ') : '未连接 · '}${platformName(peer.platform)}</span></span>${icon('arrow').replace('<svg ', '<svg class="peer-arrow" ')}</button><button class="remove-peer" data-remove-peer="${escapeHtml(peer.id)}" aria-label="移除 ${escapeHtml(peer.name)}">移除</button></div>`).join('');
}
function renderPeers() {
  const online = state.peers.filter(p => p.online);
  $('peer-count').textContent = state.peers.length; $('nearby-count').textContent = state.peers.length;
  $('nearby-devices').innerHTML = peerCards(state.peers); $('all-devices').innerHTML = peerCards(state.peers);
  $('target-device').innerHTML = '<option value="">请选择一台设备</option>' + online.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  $('target-device').value = selectedPeer;
}
function renderHistory(jobs) {
  if (!jobs.length) return `<div class="empty-history">${icon('history')}<span>还没有传输记录，开始你的第一次分享吧。</span></div>`;
  const labels = { connecting: '正在连接', pending: '已中断', awaiting: '已中断', ready: '等待文件到达', transferring: '正在传输', completed: '已完成', failed: '传输失败', cancelled: '已取消', rejected: '已拒绝' };
  return `<table class="history-table"><thead><tr><th>文件 / 内容</th><th>传输设备</th><th>状态</th><th>时间 / 操作</th></tr></thead><tbody>${jobs.map(job => {
    const glyph = fileIcon(job); let action = !terminal.has(job.status) ? `<button class="history-action" data-cancel="${job.id}" title="取消传输">取消</button>` : job.status === 'completed' && job.kind === 'text' ? `<button class="history-action" data-message="${job.id}" title="查看文字">查看文字</button>` : job.status === 'completed' && job.direction === 'incoming' ? `<button class="history-action" data-file="${job.id}" title="查看接收文件">${icon('folder')}</button>` : '';
    if (job.kind === 'text' && terminal.has(job.status)) action += `<button class="history-action delete-message" data-delete-history="${escapeHtml(job.id)}" title="删除本机文字记录">删除</button>`;
    return `<tr><td><div class="file-cell"><span class="file-icon ${glyph}">${icon(glyph)}</span><div><strong title="${escapeHtml(job.name)}">${escapeHtml(job.name)}</strong><small>${size(job.size)}${job.status === 'transferring' ? ` · ${size(job.speed)}/s` : ''}</small></div></div></td><td>${job.direction === 'incoming' ? '来自' : '发往'} ${escapeHtml(job.peerName)}</td><td><span class="transfer-status ${job.status}">${job.status === 'completed' ? icon('check') : ''}${labels[job.status]}${job.status === 'transferring' ? ` ${job.progress}%` : ''}</span>${job.status === 'transferring' ? `<progress class="transfer-progress" max="100" value="${Number(job.progress)}"></progress>` : ''}${job.error ? `<div class="transfer-error" title="${escapeHtml(job.error)}">${escapeHtml(job.error)}</div>` : ''}</td><td>${action}<span class="transfer-time">${new Date(job.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span></td></tr>`;
  }).join('')}</tbody></table>`;
}
function renderTransfers() {
  const jobs = [...state.transfers].sort((a, b) => b.createdAt - a.createdAt);
  $('recent-history').innerHTML = renderHistory(jobs.slice(0, 4)); $('full-history').innerHTML = renderHistory(jobs.filter(j => historyFilter === 'all' || j.direction === historyFilter));
}
function applyState(next) {
  const old = state; state = next;
  $('self-name').textContent = state.self.name; $('device-name').textContent = state.self.name; $('device-platform').textContent = `${platformName(state.self.platform)} 设备`;
  $('local-address').textContent = state.self.addresses.length ? `${state.self.addresses[0]}:${state.self.port}` : `127.0.0.1:${state.self.port}`;
  const interfaces = state.self.interfaces || state.self.addresses.map(address => ({ address, name: '网络连接' }));
  $('setup-local-address').innerHTML = interfaces.length ? interfaces.map(item => {
    const endpoint = `${item.address}:${state.self.port}`;
    return `<div class="local-interface"><div><span>${escapeHtml(item.name)}${item.virtual ? ' · 疑似虚拟网卡' : ''}</span><strong>${escapeHtml(endpoint)}</strong></div><button type="button" class="text-button" data-copy-endpoint="${escapeHtml(endpoint)}">复制${icon('copy')}</button></div>`;
  }).join('') : '<p>未检测到局域网 IPv4 地址，请检查 Wi-Fi 或网线连接。</p>';
  $('receive-directory').textContent = state.settings.receiveDir;
  $('warning').textContent = state.warning; $('warning').hidden = !state.warning;
  renderPeers(); renderTransfers(); updateSendButton();
  $('network-pill').classList.toggle('disconnected', !state.settings.enabled);
  $('network-pill').querySelector('span').textContent = state.settings.enabled ? '局域网传输已开启' : '局域网传输已关闭';
  if (messageId && !state.transfers.some(job => job.id === messageId)) $('message-dialog').close();
  for (const [direction, notice] of successNotices) if (!state.transfers.some(job => job.id === notice.jobId)) dismissSuccess(direction);
  if (old) for (const job of state.transfers) {
    const previous = old.transfers.find(item => item.id === job.id);
    if (job.status === 'completed' && previous?.status !== 'completed') showTransferSuccess(job);
  }
}
async function sendSelected() {
  if (!selectedPeer) return;
  if (activeTab !== 'files') { await api('/api/text', { peerId: selectedPeer, text: $('text-content').value }); $('text-content').value = ''; $('text-counter').textContent = '0 字符'; toast('已发起文字传输'); }
  else {
    const files = [...selectedFiles]; const target = selectedPeer;
    const native = files.filter(f => f.path), browser = files.filter(f => !f.path);
    if (native.length) await window.desktop.sendFiles(target, native.map(f => f.path));
    for (const file of browser) {
      fetch(`/api/file?${new URLSearchParams({ peerId: target, name: file.name, size: file.size })}`, { method: 'POST', headers: { 'X-App-Token': state.uiToken, 'Content-Type': 'application/octet-stream' }, body: file }).then(async res => { const result = await res.json(); if (!res.ok) throw new Error(result.error); }).catch(err => toast(`${file.name}：${err.message}`, true));
    }
    selectedFiles = []; renderFiles(); toast('已发起文件传输');
  }
  updateSendButton();
}
async function copy(text) { if (window.desktop) await window.desktop.copyText(text); else await navigator.clipboard.writeText(text); toast('已复制到剪贴板'); }
async function paste() { try { const text = await navigator.clipboard.readText(); $('text-content').value = text.slice(0, 50000); $('text-content').dispatchEvent(new Event('input')); } catch { toast('请在输入框中按 Ctrl + V 粘贴', true); $('text-content').focus(); } }
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  try {
    if (button.dataset.page) showPage(button.dataset.page);
    if (button.dataset.tab) { changeTab(button.dataset.tab); if (button.dataset.tab === 'clipboard') { $('text-content').focus(); toast('按 Ctrl + V 粘贴文字或截图'); } }
    if (button.dataset.action === 'add-peer') { showPage('devices'); $('peer-address').focus(); }
    if (button.dataset.close) $(button.dataset.close).close();
    if (button.dataset.dismissSuccess) dismissSuccess(button.dataset.dismissSuccess);
    if (button.dataset.deleteHistory) {
      button.disabled = true;
      try { await api(`/api/history/${encodeURIComponent(button.dataset.deleteHistory)}`, undefined, 'DELETE'); toast('已删除本机文字记录'); }
      finally { button.disabled = false; }
    }
    if (button.dataset.peer) { choosePeer(button.dataset.peer); if (currentPage === 'devices') showPage('home'); }
    if (button.dataset.removeFile !== undefined) { selectedFiles.splice(Number(button.dataset.removeFile), 1); renderFiles(); }
    if (button.dataset.cancel) await api('/api/cancel', { id: button.dataset.cancel });
    if (button.dataset.removePeer) { await api(`/api/peers/${button.dataset.removePeer}`, undefined, 'DELETE'); if (selectedPeer === button.dataset.removePeer) selectedPeer = ''; renderPeers(); updateSendButton(); toast('已移除设备'); }
    if (button.dataset.filter) { historyFilter = button.dataset.filter; document.querySelectorAll('.filter').forEach(x => x.classList.toggle('active', x === button)); renderTransfers(); }
    if (button.dataset.message) { messageId = button.dataset.message; message = state.transfers.find(j => j.id === messageId)?.text || ''; $('received-message').textContent = message; $('delete-open-message').dataset.deleteHistory = messageId; $('message-dialog').showModal(); }
    if (button.dataset.file) { if (window.desktop) await window.desktop.showFile(button.dataset.file); else { const response = await fetch(`/api/download/${button.dataset.file}`, { method: 'HEAD', headers: { 'X-App-Token': state.uiToken } }); if (!response.ok) throw new Error('接收文件已被移动或删除'); const link = document.createElement('a'); link.href = `/api/download/${button.dataset.file}?token=${state.uiToken}`; link.download = state.transfers.find(j => j.id === button.dataset.file)?.name; link.click(); } }
    if (button.id === 'choose-files') await chooseFiles();
    if (button.id === 'send-button') await sendSelected();
    if (button.id === 'scan-button' || button.id === 'check-connections') { button.disabled = true; try { await api('/api/scan'); toast('已检查已配置设备的连接'); } finally { button.disabled = false; } }
    if (button.id === 'copy-address') await copy($('local-address').textContent);
    if (button.dataset.copyEndpoint) await copy(button.dataset.copyEndpoint);
    if (button.id === 'copy-message') await copy(message);
    if (button.id === 'paste-text') await paste();
    if (button.id === 'open-folder') { if (window.desktop) { const error = await window.desktop.openFolder(); if (error) throw new Error(error); } else { showPage('settings'); toast(`接收目录：${state.settings.receiveDir}`); } }
    if (button.id === 'choose-folder') { if (window.desktop) await window.desktop.chooseFolder(); else toast('更改接收目录请使用桌面版；浏览器版使用页面显示的目录。'); }
    if (button.id === 'clear-history') { if (confirm('清空已完成和已结束的记录？接收到的文件会保留。')) await api('/api/history', undefined, 'DELETE'); }
  } catch (err) { toast(err.message, true); }
});
$('target-device').addEventListener('change', event => choosePeer(event.target.value));
$('message-dialog').addEventListener('close', () => { message = ''; messageId = ''; $('received-message').textContent = ''; delete $('delete-open-message').dataset.deleteHistory; });
$('file-input').addEventListener('change', event => { addFiles([...event.target.files]); event.target.value = ''; });
$('text-content').addEventListener('input', () => { $('text-counter').textContent = `${$('text-content').value.length.toLocaleString()} 字符`; updateSendButton(); });
$('peer-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('connect-button'), error = $('connection-error');
  button.disabled = true; button.textContent = '正在连接…'; error.hidden = true;
  try {
    const result = await api('/api/peers', { address: $('peer-address').value });
    selectedPeer = result.id; renderPeers(); updateSendButton(); $('peer-address').value = '';
    toast('配置已保存；请在另一台软件里也添加这台电脑');
  } catch (err) { error.textContent = err.message; error.hidden = false; }
  finally { button.disabled = false; button.innerHTML = `${icon('plus')}保存设备`; }
});
$('settings-form').addEventListener('submit', async event => { event.preventDefault(); try { await api('/api/settings', { name: $('settings-name').value, enabled: $('lan-enabled').checked }); toast('设置已保存'); } catch (err) { toast(err.message, true); } });
$('drop-zone').addEventListener('click', event => { if (!event.target.closest('button')) chooseFiles().catch(err => toast(err.message, true)); });
$('drop-zone').addEventListener('keydown', event => { if (event.target === $('drop-zone') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); chooseFiles().catch(err => toast(err.message, true)); } });
document.addEventListener('dragover', event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) $('drop-zone').classList.add('dragging'); });
document.addEventListener('dragleave', event => { if (!event.relatedTarget) $('drop-zone').classList.remove('dragging'); });
document.addEventListener('drop', event => { event.preventDefault(); $('drop-zone').classList.remove('dragging'); if (event.dataTransfer.files.length) { showPage('home'); addFiles([...event.dataTransfer.files]); } });
document.addEventListener('paste', event => { if (currentPage !== 'home') return; const files = [...(event.clipboardData?.files || [])]; if (files.length) { event.preventDefault(); addFiles(files.map(file => file.name === 'image.png' ? new File([file], `截图-${Date.now()}.png`, { type: file.type }) : file)); toast('截图已加入待发送列表'); } });
async function init() {
  try {
    const response = await fetch('/api/state'); if (!response.ok) throw new Error('无法连接本机服务'); applyState(await response.json());
    $('settings-name').value = state.self.name; $('lan-enabled').checked = state.settings.enabled;
    if (!window.desktop) { $('choose-folder').textContent = '桌面版可更改'; $('folder-help').textContent = '浏览器版接收文件保存在此目录，也可在传输记录中下载。'; }
    events = new EventSource(`/api/events?token=${state.uiToken}`);
    events.onmessage = event => { applyState(JSON.parse(event.data)); };
    events.onerror = () => { $('network-pill').classList.add('disconnected'); $('network-pill').querySelector('span').textContent = '正在重新连接'; };
  } catch (err) { toast(err.message, true); $('network-pill').classList.add('disconnected'); $('network-pill').querySelector('span').textContent = '服务连接失败'; }
}
init();
