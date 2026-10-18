// 三交易所整合配置加载器
// 支持全局代理（GLOBAL_PROXY）+ 各交易所独立代理覆盖
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = process.env.WG_DATA_DIR
  ? path.resolve(process.env.WG_DATA_DIR)
  : root;

export function loadEnv() {
  const file = path.join(dataRoot, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2].trim();
        const q = v.match(/^"([^"]*)"|^'([^']*)'/); // quoted: take the quoted content
        if (q) v = q[1] ?? q[2];
        else v = v.replace(/\s+#.*$/, '').trim();   // unquoted: strip inline comments
        process.env[m[1]] = v;
      }
    }
  }
}

export function getConfig() {
  loadEnv();

  // 全局代理：作为所有交易所的默认代理
  const globalProxy =
    process.env.GLOBAL_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    '';

  // ── Decibel ──────────────────────────────────────────────────────────────
  const deNet = (process.env.DE_NETWORK || 'mainnet').toLowerCase();
  const deDefaults =
    deNet === 'testnet'
      ? { api: 'https://api.testnet.aptoslabs.com/decibel' }
      : { api: 'https://api.mainnet.aptoslabs.com/decibel' };

  const de = {
    mode: (process.env.DE_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: deNet,
    apiKey: process.env.DECIBEL_API_KEY || '',
    privateKey: process.env.DECIBEL_PRIVATE_KEY || '',
    subaccount: process.env.DECIBEL_SUBACCOUNT || '',
    apiUrl: (process.env.DECIBEL_API_URL || deDefaults.api).replace(/\/$/, ''),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.DECIBEL_PROXY || globalProxy,
  };

  // ── Extended ──────────────────────────────────────────────────────────────
  const exNet = (process.env.EX_NETWORK || 'mainnet').toLowerCase();
  const exDefaults =
    exNet === 'testnet'
      ? { api: 'https://api.starknet.sepolia.extended.exchange' }
      : { api: 'https://api.starknet.extended.exchange' };

  const ex = {
    mode: (process.env.EX_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: exNet,
    apiKey: process.env.EXTENDED_API_KEY || '',
    vault: process.env.EXTENDED_VAULT || '',
    starkPrivateKey: process.env.EXTENDED_STARK_PRIVATE_KEY || '',
    starkPublicKey: process.env.EXTENDED_STARK_PUBLIC_KEY || '',
    feeRate: process.env.EXTENDED_MAX_FEE || '0.0005',
    apiUrl: (process.env.EXTENDED_API_URL || exDefaults.api).replace(/\/$/, ''),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.EXTENDED_PROXY || globalProxy,
  };

  // ── RISEx ─────────────────────────────────────────────────────────────────
  const rsNet = (process.env.RS_NETWORK || 'mainnet').toLowerCase();
  const rsDefaults =
    rsNet === 'testnet'
      ? { api: 'https://api.testnet.rise.trade', ws: 'wss://ws.testnet.rise.trade' }
      : { api: 'https://api.risex.trade', ws: 'wss://ws.risex.trade' };

  const rs = {
    mode: (process.env.RS_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: rsNet,
    account: process.env.ACCOUNT_ADDRESS || '',
    signerKey: process.env.SIGNER_PRIVATE_KEY || '',
    apiUrl: process.env.RISEX_API_URL || rsDefaults.api,
    wsUrl: process.env.RISEX_WS_URL || rsDefaults.ws,
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.RISEX_PROXY || globalProxy,
  };

  // ── BSC 用户钱包 + 隐藏结算链 ───────────────────────────────────────────
  // 用户只看到 BSC；后台使用 Optimism 作为跨链归集和出款结算链。
  // Optimism 必须保持 public:false，避免用户误选结算链直接转账。
  const depositAddress = process.env.PLATFORM_DEPOSIT_ADDRESS || process.env.BSC_DEPOSIT_ADDRESS || '';
  const wallet = {
    depositAddress,
    withdrawalAddress: process.env.PLATFORM_WITHDRAWAL_ADDRESS || depositAddress,
    withdrawalPrivateKey: process.env.PLATFORM_WITHDRAWAL_PRIVATE_KEY || '',
    autoWithdrawalEnabled: process.env.PLATFORM_AUTO_WITHDRAWAL_ENABLED === '1',
    autoWithdrawalReviewThresholdUsdt: process.env.PLATFORM_WITHDRAWAL_REVIEW_THRESHOLD_USDT || '1000',
    autoWithdrawalDailyLimitUsdt: process.env.PLATFORM_WITHDRAWAL_AUTO_DAILY_LIMIT_USDT || process.env.PLATFORM_WITHDRAWAL_REVIEW_THRESHOLD_USDT || '1000',
    networks: [
      { id:'bsc', name:'BNB Smart Chain', chainId:56, rpcUrl:process.env.BSC_RPC_URL || 'https://bsc-rpc.publicnode.com', browserRpcUrl:process.env.BSC_BROWSER_RPC_URL || 'https://bsc-rpc.publicnode.com', nativeSymbol:'BNB', tokenContract:'0x55d398326f99059fF775485246999027B3197955', tokenDecimals:18, confirmations:Number(process.env.BSC_CONFIRMATIONS || 15), explorerUrl:'https://bscscan.com' },
      { id:'optimism', name:'Optimism (平台结算)', chainId:10, rpcUrl:process.env.OPTIMISM_RPC_URL || 'https://optimism-rpc.publicnode.com', browserRpcUrl:process.env.OPTIMISM_RPC_URL || 'https://optimism-rpc.publicnode.com', nativeSymbol:'ETH', tokenContract:process.env.OPTIMISM_USDT_CONTRACT || '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', tokenDecimals:6, confirmations:Number(process.env.OPTIMISM_CONFIRMATIONS || 20), explorerUrl:'https://optimistic.etherscan.io', public:false },
    ],
    sessionHours: Number(process.env.WALLET_SESSION_HOURS || 24),
    bridge: {
      enabled:process.env.PLATFORM_BRIDGE_ENABLED === '1',
      settlementNetwork:(process.env.PLATFORM_SETTLEMENT_NETWORK || 'optimism').toLowerCase(),
      apiUrl:process.env.LIFI_API_URL || 'https://li.quest/v1',
      apiKey:process.env.LIFI_API_KEY || '',
      allowedBridges:(process.env.PLATFORM_ALLOWED_BRIDGES || 'across,stargateV2').split(',').map(value => value.trim()).filter(Boolean),
      slippageBps:Number(process.env.PLATFORM_BRIDGE_SLIPPAGE_BPS || 30),
      minimumReceivedBps:Number(process.env.PLATFORM_BRIDGE_MIN_RECEIVED_BPS || 9900),
    },
    // USDC→USDT 闪兑提现：出款钱包囤 USDC，用户提现时走 PancakeSwap V3 纯链上兑换，USDT 由 V3 池直打用户地址
    // 纯链上方案：无第三方 API、无需 Key、无限流；主网合约地址通过 CREATE2 多链同址
    swap: {
      enabled:process.env.PLATFORM_SWAP_WITHDRAWAL_ENABLED === '1',
      usdcContract:process.env.USDC_CONTRACT_ADDRESS || '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      v3Router:process.env.PANCAKE_V3_ROUTER || '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
      v3Quoter:process.env.PANCAKE_V3_QUOTER || '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
      v3FeeTiers:(process.env.PANCAKE_V3_FEE_TIERS || '100,500').split(',').map(value => Number(value.trim())).filter(Boolean),
      slippageBps:Math.min(200, Math.max(10, Number(process.env.PLATFORM_SWAP_SLIPPAGE_BPS) || 30)),
    },
  };

  return {
    port: Number(process.env.PORT || 8080),
    // SECURITY: bind to loopback by default so the dashboard (which can start/stop
    // LIVE trading and edit .env) is NOT exposed to the local network. Set
    // HOST=0.0.0.0 explicitly only if you understand the risk and add your own auth.
    host: process.env.HOST || '127.0.0.1',
    operatorToken: process.env.PLATFORM_ADMIN_TOKEN || '',
    trustProxy: process.env.TRUST_PROXY === '1',
    globalProxy,
    de,
    ex,
    rs,
    wallet,
  };
}

export const ROOT = root;
export const DATA_ROOT = dataRoot;
