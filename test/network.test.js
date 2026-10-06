const { test } = require('node:test');
const assert = require('node:assert/strict');
const { networkAddresses, connectionError } = require('../server/network');

test('网卡地址保留名称、排除回环和非局域网地址，并将疑似虚拟网卡排在后面', () => {
  const addresses = networkAddresses({
    'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.20.0.1', netmask: '255.255.0.0' }],
    'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.10.12', netmask: '255.255.255.0' }, { family: 'IPv6', internal: false, address: 'fe80::1' }],
    'Loopback': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    'Other': [{ family: 'IPv4', internal: false, address: '203.0.113.10' }],
    'Empty': undefined
  });
  assert.equal(addresses.length, 2);
  assert.equal(addresses[0].name, 'Wi-Fi');
  assert.equal(addresses[1].virtual, true);
});

test('连接错误区分端口尚未连通、端口已连通但没有回应和连接被拒绝', () => {
  const timeout = Object.assign(new Error(), { name: 'AbortError' });
  assert.match(connectionError(timeout), /尚未连上对方端口/);
  assert.match(connectionError(timeout, true), /端口已连接/);
  assert.match(connectionError({ code: 'ECONNREFUSED' }), /端口拒绝连接/);
  assert.match(connectionError({ code: 'EHOSTUNREACH' }), /无法到达对方网络/);
});
