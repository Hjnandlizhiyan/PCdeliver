const os = require('node:os');
function networkAddresses(interfaces = os.networkInterfaces()) {
  return Object.entries(interfaces).flatMap(([name, addresses]) => (addresses || [])
    .filter(x => (x.family === 'IPv4' || x.family === 4) && !x.internal && privateAddress(x.address) && !x.address.startsWith('127.'))
    .map(x => ({ name, address: x.address, netmask: x.netmask,
      virtual: /virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|vpn|tun|tap|tailscale|zerotier|clash|mihomo|虚拟/i.test(name) })))
    .sort((a, b) => Number(a.virtual) - Number(b.virtual));
}
function privateAddress(address) {
  if (typeof address !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address) || address.split('.').some(x => +x > 255)) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}
function connectionError(error, connected = false) {
  if (error.name === 'AbortError' || error.name === 'TimeoutError' || error.code === 'ETIMEDOUT') {
    return connected ? '对方端口已连接，但服务回应超时。请确认对方软件正常运行，并在稍后重试。'
      : '连接超时，尚未连上对方端口。请核对网卡地址、端口、防火墙和路由器设备隔离设置。';
  }
  if (error.code === 'ECONNREFUSED') return '对方端口拒绝连接。请打开对方软件，并核对连接地址中的端口。';
  if (['EHOSTUNREACH', 'ENETUNREACH'].includes(error.code)) return '无法到达对方网络。请确认两台电脑连接同一个局域网，并检查 VPN 或虚拟网卡。';
  if (['EACCES', 'EPERM'].includes(error.code)) return '系统阻止了连接。请检查防火墙或安全软件是否允许局域传送通信。';
  if (error.code === 'ECONNRESET') return '对方中断了连接。请确认对方软件仍在运行，然后重试。';
  if (error instanceof SyntaxError) return '对方端口有回应，但内容不是局域传送的数据。请核对软件和端口。';
  return error.message;
}
module.exports = { networkAddresses, privateAddress, connectionError };
