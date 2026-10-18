import assert from 'node:assert/strict';
import { Wallet } from 'ethers';

const wallet = Wallet.createRandom();
const providerListeners = new Map();
const requests = [];
const provider = {
  isMetaMask:true,
  async request({ method, params = [] }) {
    requests.push({ method, params });
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.address];
    if (method === 'eth_chainId') return '0x61';
    throw new Error(`Unexpected wallet method: ${method}`);
  },
  on(event, listener) { providerListeners.set(event, listener); },
  removeListener(event) { providerListeners.delete(event); },
};

globalThis.window = {
  ethereum:provider,
  dispatchEvent() {},
};
globalThis.Event = class Event { constructor(type) { this.type = type; } };

await import(`../frontend/wallet-connector.js?test=${Date.now()}`);
const connector = window.WGWalletConnector;
await connector.initialize();

const connection = await connector.connect();
assert.equal(connection.address, wallet.address);
assert.equal(connection.label, 'MetaMask');
assert.equal(requests.filter(item => item.method === 'eth_requestAccounts').length, 1);

// 连接器不再内置任何签名/授权方法
for (const removed of ['signMessage', 'signLoginChallenge', 'inspectPermitAuthorization', 'submitPermitAuthorization', 'batchSign']) {
  assert.equal(typeof connector[removed], 'undefined', `${removed} 应已移除`);
}

// getChainId 透传钱包当前链
assert.equal(await connector.getChainId(), 97);
assert.equal(await connector.switchChain(97),97);
assert.equal(requests.some(item => item.method === 'wallet_switchEthereumChain'),false, 'Already on target chain: sign without an extra switch request');

const originalRequest = provider.request;
let finishOldAccounts;
provider.request = ({method}) => method === 'eth_accounts'
  ? new Promise(resolve => { finishOldAccounts=resolve; }) : originalRequest({method});
const oldRestore = connector.restore();
const nextAddress = Wallet.createRandom().address;
providerListeners.get('accountsChanged')([nextAddress]);
finishOldAccounts([wallet.address]);
assert.equal((await oldRestore).address,nextAddress, 'Late account reads must not override accountsChanged');
provider.request = ({method}) => method === 'eth_accounts' ? new Promise(() => {}) : originalRequest({method});
const restoreStart = Date.now();
assert.equal((await connector.restore()).address,nextAddress);
assert(Date.now()-restoreStart < 2000, 'A stalled eth_accounts request must not freeze startup');
provider.request = originalRequest;

let changed = 'not-called';
connector.onChange(value => { changed = value; });
providerListeners.get('accountsChanged')([]);
assert.equal(changed, null);

console.log('wallet-connector tests passed');
