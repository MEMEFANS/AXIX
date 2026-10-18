// 浏览器钱包连接器：只负责连接/恢复/断开、链切换、连接状态订阅。
// 登录签名（EIP-712 Login）与充值授权（ERC-2612 Permit）均由页面直接通过
// connection.provider 发起，typedData 全部由后端构造，本模块不内置任何签名/授权逻辑。

// Global polyfill for BigInt JSON serialization
// This prevents "Do not know how to serialize a BigInt" errors when passing
// ethers.js objects (which may contain BigInt values) to JSON.stringify
if (typeof BigInt !== 'undefined' && !BigInt.prototype.toJSON) {
  BigInt.prototype.toJSON = function() {
    return this.toString();
  };
}

const listeners = new Set();
let currentProvider = null;
let currentAddress = '';
let lastEmittedAddress = null;

function providerLabel(provider) {
  if (provider?.isMetaMask) return 'MetaMask';
  if (provider?.isCoinbaseWallet) return 'Coinbase Wallet';
  if (provider?.isBraveWallet) return 'Brave Wallet';
  return '浏览器钱包';
}

function injectedProvider() {
  const provider = window.ethereum;
  return provider?.request ? provider : null;
}

function connection() {
  return currentProvider && currentAddress ? {
    address:currentAddress,
    label:providerLabel(currentProvider),
    provider:currentProvider,
  } : null;
}

function emit() {
  const key = currentAddress.toLowerCase();
  if (key === lastEmittedAddress) return;
  lastEmittedAddress = key;
  const value = connection();
  listeners.forEach(listener => listener(value));
}

function setAddress(address) {
  currentAddress = String(address || '');
  emit();
}

function bindProvider(provider) {
  if (currentProvider === provider) return;
  if (currentProvider?.removeListener) {
    currentProvider.removeListener('accountsChanged', handleAccountsChanged);
    currentProvider.removeListener('disconnect', handleDisconnect);
  }
  currentProvider = provider;
  provider?.on?.('accountsChanged', handleAccountsChanged);
  provider?.on?.('disconnect', handleDisconnect);
}

function handleAccountsChanged(accounts) {
  setAddress(Array.isArray(accounts) ? accounts[0] : '');
}

function handleDisconnect() {
  setAddress('');
}

async function initialize() {}

async function connect() {
  const provider = injectedProvider();
  if (!provider) throw new Error('未检测到浏览器钱包，请先安装或启用钱包扩展');
  bindProvider(provider);
  const accounts = await provider.request({ method:'eth_requestAccounts' });
  setAddress(Array.isArray(accounts) ? accounts[0] : '');
  if (!currentAddress) throw new Error('钱包未返回可用账户');
  return connection();
}

async function restore() {
  const provider = injectedProvider();
  if (!provider) return null;
  bindProvider(provider);
  const accounts = await provider.request({ method:'eth_accounts' }).catch(() => []);
  setAddress(Array.isArray(accounts) ? accounts[0] : '');
  return connection();
}

async function disconnect() {
  setAddress('');
}

async function getChainId() {
  const value = connection();
  if (!value) throw new Error('请先连接钱包');
  return Number(BigInt(await value.provider.request({ method:'eth_chainId' })));
}

const CHAIN_DEFAULTS = {
  56: { chainName:'BNB Smart Chain', rpcUrls:['https://bsc-dataseed.binance.org/', 'https://bsc-rpc.publicnode.com'], nativeCurrency:{ name:'BNB', symbol:'BNB', decimals:18 }, blockExplorerUrls:['https://bscscan.com'] },
  97: { chainName:'BNB Smart Chain Testnet', rpcUrls:['https://data-seed-prebsc-1-s1.binance.org:8545/'], nativeCurrency:{ name:'tBNB', symbol:'tBNB', decimals:18 }, blockExplorerUrls:['https://testnet.bscscan.com'] },
};

function toHex(num) {
  if (typeof num === 'bigint') return `0x${num.toString(16)}`;
  const n = Number(num);
  if (!Number.isFinite(n)) throw new Error('无效的 chainId');
  return `0x${Math.floor(Math.abs(n)).toString(16)}`;
}

async function switchChain(targetChainId, options = {}) {
  const value = connection();
  if (!value) throw new Error('请先连接钱包');
  const id = Number(targetChainId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('目标链 ID 无效');
  const chainIdHex = toHex(id);
  const preset = CHAIN_DEFAULTS[id] || {};
  const chainName = options.chainName || preset.chainName || `Chain ${id}`;
  const rpcUrls = (Array.isArray(options.rpcUrls) && options.rpcUrls.length ? options.rpcUrls : preset.rpcUrls) || [];
  const nativeCurrency = options.nativeCurrency || preset.nativeCurrency || { name:'ETH', symbol:'ETH', decimals:18 };
  const blockExplorerUrls = (Array.isArray(options.blockExplorerUrls) && options.blockExplorerUrls.length ? options.blockExplorerUrls : preset.blockExplorerUrls) || [];
  // 尝试直接切换
  try {
    await value.provider.request({
      method:'wallet_switchEthereumChain',
      params:[{ chainId: chainIdHex }],
    });
    // 部分钱包异步更新 chainId，稍等再读
    for (let i = 0; i < 10; i++) {
      try {
        const current = Number(BigInt(await value.provider.request({ method:'eth_chainId' })));
        if (current === id) return current;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    return Number(BigInt(await value.provider.request({ method:'eth_chainId' })));
  } catch (err) {
    // code=4902 表示 MetaMask 尚未添加该网络；-32603 是某些钱包通用内部错误，也尝试 addChain
    const code = Number(err?.code ?? 0);
    const msg = String(err?.message || '').toLowerCase();
    if (code === 4902 || code === -32603 || msg.includes('unrecognized') || msg.includes('was not found') || msg.includes('add ethereum chain')) {
      if (!rpcUrls.length) throw new Error(`钱包未添加 ${chainName}，且未提供 RPC URL 以供自动添加`);
      const addParams = [{
        chainId: chainIdHex,
        chainName,
        rpcUrls,
        nativeCurrency,
        blockExplorerUrls,
      }];
      try {
        await value.provider.request({ method:'wallet_addEthereumChain', params: addParams });
      } catch (addErr) {
        throw new Error(`添加 ${chainName} 失败：${addErr?.message || String(addErr)}`);
      }
      // 添加成功后，部分钱包会自动切，有些需要再调一次 switch
      for (let i = 0; i < 10; i++) {
        try {
          const current = Number(BigInt(await value.provider.request({ method:'eth_chainId' })));
          if (current === id) return current;
        } catch {}
        try {
          await value.provider.request({ method:'wallet_switchEthereumChain', params:[{ chainId: chainIdHex }] });
        } catch {}
        await new Promise((r) => setTimeout(r, 250));
      }
      const current = Number(BigInt(await value.provider.request({ method:'eth_chainId' })));
      if (current !== id) throw new Error(`已添加 ${chainName} 但仍未切换，请手动切换`);
      return current;
    }
    throw err;
  }
}

function getConnection() {
  return connection();
}

function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

window.WGWalletConnector = {
  initialize,
  connect,
  restore,
  disconnect,
  getChainId,
  switchChain,
  getConnection,
  onChange,
  destroy:() => {
    if (!currentProvider?.removeListener) return;
    currentProvider.removeListener('accountsChanged', handleAccountsChanged);
    currentProvider.removeListener('disconnect', handleDisconnect);
  },
};
window.dispatchEvent(new Event('wg-wallet-connector-ready'));
