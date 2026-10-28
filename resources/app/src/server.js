// 三交易所整合服务器
// 路由规则：
//   /api/de/*  → Decibel 交易所
//   /api/ex/*  → Extended 交易所
//   /api/rs/*  → RISEx 交易所
//   /api/overview → 三交易所总览（余额+盈亏）
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { formatUnits } from 'ethers';
import { readAdminAixIncome } from './a-token-admin-income.js';
import { getConfig, ROOT, DATA_ROOT } from './config.js';
import { createExchange as createDeExchange } from './exchange/de/index.js';
import { createExchange as createExExchange } from './exchange/ex/index.js';
import { createExchange as createRsExchange } from './exchange/rs/index.js';
import { GridBot } from './bot.js';
import { analyzeTrend } from './trend.js';
import { setupProxies, checkProxy } from './proxy.js';
import { flushState, loadSnapshot, saveSnapshot } from './persist.js';
import { createAiService } from './ai/service.js';
import { createTradeLedger } from './ledger.js';
import { createWalletService } from './wallet-service.js';
import { PLATFORM_SYMBOLS, createPlatformService, setPlatformSymbols } from './platform-service.js';
import { createMarketCatalog, toBinanceMarketSymbol } from './market-catalog.js';
import { createAdminAuth } from './admin-auth.js';
import { createFundsAdminApi } from './funds-admin-api.js';
import { OPERATOR_ADMIN_CSP, FUNDS_ADMIN_CSP, adminPageKind, isLegacyFundsPath } from './admin-security.js';
import { createAgentAuth, hashPassword } from './agent-auth.js';
import { createAgentService } from './agent-service.js';
import { createCommunityLinksService } from './community-links.js';
import { createCommunityLinksApi } from './community-links-api.js';
import { createWithdrawalPayoutService } from './withdrawal-payout-service.js';
import { createBridgeService } from './bridge-service.js';
import { createPlatformApi } from './platform-api.js';
import { createInternalStrategyApi } from './internal-strategy-api.js';
import { createInternalStrategyService } from './internal-strategy-service.js';
import { createAiManagedApi } from './ai-managed-api.js';
import { createAiManagedService } from './ai-managed-service.js';
import { createReferralApi } from './referral-api.js';
import { createReferralService } from './referral-service.js';
import { createATokenService, A_TOKEN_DECIMALS } from './a-token-service.js';
import { createATokenPoolService } from './a-token-pool-service.js';
import { createATokenMinerService } from './a-token-miner-service.js';
import { createATokenTeamService } from './a-token-team-service.js';
import { createATokenStakingService } from './a-token-staking-service.js';
import { createATokenTransferService } from './a-token-transfer-service.js';
import { createATokenActivationService } from './a-token-activation-service.js';
import { createATokenKlineService } from './a-token-kline-service.js';
import { createATokenOrderService } from './a-token-order-service.js';
import { createATokenApi } from './a-token-api.js';
import { createRunAixGameApi } from './run-aix-game-api.js';
import { createHashAixGameApi } from './hash-aix-game-api.js';
import { createATokenAdminApi } from './a-token-admin-api.js';
import { createSupportService } from './support-service.js';
import { createSupportApi } from './support-api.js';
import { createATokenWithdrawalService } from './a-token-withdrawal-service.js';
import { createATokenClaimService } from './a-token-claim-service.js';
import { createLotteryService } from './lottery-service.js';
import { createAirdropPointsService } from './airdrop-points-service.js';
import { createLotteryApi } from './lottery-api.js';
import { fetchFuturesCandles, fetchFuturesOrderBook, fetchFuturesPrices, fetchFuturesTickers, fetchFuturesTrades, fetchPublicCandles, fetchPublicOrderBook, fetchPublicPrices, fetchPublicTickers, fetchPublicTrades, marketFetch, subscribeFuturesPrices, subscribeFuturesTradePrices, subscribePublicPrices } from './market-data/public.js';

// ── 启动配置 ─────────────────────────────────────────────────────────────────
const cfg = getConfig();

// ── 实盘凭据预检查：缺什么直接列出来，不甩堆栈吓人 ─────────────────────────────
{
  const missing = [];
  if (cfg.de.mode === 'live') {
    if (!cfg.de.apiKey) missing.push(['Decibel ', 'DECIBEL_API_KEY', '在 geomi.dev 免费创建']);
    if (!cfg.de.privateKey) missing.push(['Decibel ', 'DECIBEL_PRIVATE_KEY', '在 app.decibel.trade/api 创建 API 钱包']);
  }
  if (cfg.ex.mode === 'live') {
    if (!cfg.ex.apiKey) missing.push(['Extended', 'EXTENDED_API_KEY', 'app.extended.exchange → API Management']);
    if (!cfg.ex.vault) missing.push(['Extended', 'EXTENDED_VAULT', '同上，创建 API Key 时一并显示']);
    if (!cfg.ex.starkPrivateKey) missing.push(['Extended', 'EXTENDED_STARK_PRIVATE_KEY', '同上，只显示一次务必保存']);
  }
  if (cfg.rs.mode === 'live') {
    if (!cfg.rs.account) missing.push(['RISEx   ', 'ACCOUNT_ADDRESS', 'RISEx 应用的账户 / API 设置']);
    if (!cfg.rs.signerKey) missing.push(['RISEx   ', 'SIGNER_PRIVATE_KEY', 'RISEx 应用的账户 / API 设置']);
  }
  if (missing.length) {
    console.error('\n[启动失败] 有交易所被设为 live 实盘模式，但 .env 里还缺以下凭据：\n');
    for (const [ex, key, where] of missing) {
      console.error(`  ${ex}  缺 ${key}`);
      console.error(`            获取方式：${where}`);
    }
    console.error('\n解决办法（二选一）：');
    console.error('  1. 用记事本打开项目里的 .env，补齐上面列出的字段');
    console.error('     （详细获取教程见 README.md 第七节）');
    console.error('  2. 暂时不实盘：把 .env 里对应的 DE_MODE / EX_MODE / RS_MODE 改回 paper\n');
    process.exit(1);
  }
}

// ── 代理设置 ─────────────────────────────────────────────────────────────────
const proxyResult = await setupProxies(cfg);
if (proxyResult.used) {
  console.log('[代理] 已启用: ' + proxyResult.used);
  console.log('[代理检测] 正在验证代理可用性...');
  const chk = await checkProxy();
  if (chk.ok) {
    console.log('[代理检测] ✓ 代理正常，当前出口 IP: ' + chk.ip);
  } else {
    console.error('[代理检测] ✗ 代理无法联网：' + chk.error);
    const hasLive = cfg.de.mode === 'live' || cfg.ex.mode === 'live' || cfg.rs.mode === 'live';
    if (hasLive) {
      console.error('  实盘模式已中止启动，以免在断网状态下运行造成挂单失控。');
      process.exit(1);
    } else {
      console.error('  模拟模式将继续运行，但可能拿不到真实行情。');
    }
  }
} else {
  console.log('[代理] 未配置（直连模式）');
}

// ── 全局异常兜底：防止单个请求异常把整个 Node 进程拖垮 ───────────────────────
process.on('uncaughtException', (err) => {
  const ts = new Date().toISOString();
  console.error(`[uncaughtException ${ts}] ${err?.stack || err?.message || err}`);
});
process.on('unhandledRejection', (reason) => {
  const ts = new Date().toISOString();
  console.error(`[unhandledRejection ${ts}] ${reason?.stack || reason?.message || reason}`);
});

// ── 创建三个交易所和机器人 ────────────────────────────────────────────────────
const deExchange = createDeExchange(cfg.de);
const exExchange = createExExchange(cfg.ex);
const rsExchange = createRsExchange(cfg.rs);

function recoverLegacyPaperSnapshot(key, snapshot) {
  if (!snapshot?.config || (snapshot.stats?.completedRungs || 0) <= 0) return snapshot;
  if (snapshot.paperAccount?.version === 1) return snapshot;
  const candidates = [];
  const addCandidate = (state) => {
    const baseline = state?.ai?.baseline;
    const realized = baseline?.per?.[key]?.realizedPnl;
    if (!Number.isFinite(Number(realized)) || Number(realized) === 0) return;
    candidates.push({ t: Number(baseline.t) || 0, realized: Number(realized) });
  };
  addCandidate({ ai: loadSnapshot('ai') });
  try {
    const recoveryFile = path.join(DATA_ROOT, 'ledger-recovery.json');
    if (fs.existsSync(recoveryFile)) {
      const recovery = JSON.parse(fs.readFileSync(recoveryFile, 'utf8'));
      const realized = recovery?.per?.[key]?.realizedPnl;
      if (recovery?.version === 1 && Number.isFinite(Number(realized))) {
        candidates.push({ t: Number(recovery.baselineT) || 0, realized: Number(realized), authoritative: true });
      }
    }
  } catch { /* best-effort one-time recovery */ }
  try {
    const backupDir = path.join(DATA_ROOT, 'state-backups');
    if (fs.existsSync(backupDir)) {
      for (const file of fs.readdirSync(backupDir)) {
        if (!file.endsWith('.json')) continue;
        try { addCandidate(JSON.parse(fs.readFileSync(path.join(backupDir, file), 'utf8'))); } catch {}
      }
    }
  } catch { /* best-effort migration */ }
  candidates.sort((a, b) => Number(b.authoritative) - Number(a.authoritative) || b.t - a.t);
  const best = candidates[0];
  if (!best) return snapshot;
  const afterBaseline = (snapshot.fills || [])
    .filter((fill) => Number(fill.t) > best.t)
    .reduce((sum, fill) => sum + (Number(fill.realizedPnl) || 0), 0);
  return { ...snapshot, forceLegacyPaperRestore: true, legacyRealizedPnl: best.realized + afterBaseline };
}

const restoredSnapshots = {
  de: recoverLegacyPaperSnapshot('de', loadSnapshot('de')),
  ex: recoverLegacyPaperSnapshot('ex', loadSnapshot('ex')),
  rs: recoverLegacyPaperSnapshot('rs', loadSnapshot('rs')),
};

const tradeLedger = createTradeLedger();
const exchangeNames = { de: 'Decibel', ex: 'Extended', rs: 'RISEx' };
for (const key of ['de', 'ex', 'rs']) {
  tradeLedger.importSnapshot(key, restoredSnapshots[key]?.fills || [], {
    market: restoredSnapshots[key]?.config?.displayName || restoredSnapshots[key]?.config?.marketId || null,
    mode: cfg[key].mode,
  });
}

function botOptions(key) {
  return {
    onChange: (snapshot) => saveSnapshot(key, snapshot),
    onFillRecord: (fill) => tradeLedger.append(key, fill, {
      market: bots[key]?.config?.displayName || bots[key]?.config?.marketId || null,
      mode: cfg[key].mode,
    }),
  };
}
const bots = {};
const deBot = bots.de = new GridBot(deExchange, botOptions('de'));
const exBot = bots.ex = new GridBot(exExchange, botOptions('ex'));
const rsBot = bots.rs = new GridBot(rsExchange, botOptions('rs'));

// Restore cumulative stats / config from the previous run (display continuity).
// Trading does NOT auto-resume; stray-order cleanup happens after each exchange
// finishes init (see below).
deBot.restore(restoredSnapshots.de);
exBot.restore(restoredSnapshots.ex);
rsBot.restore(restoredSnapshots.rs);

// Belt-and-suspenders: ensure every exchange always has an 'error' listener so a
// stray emit can never crash the process (the GridBot also attaches one).
for (const ex of [deExchange, exExchange, rsExchange]) {
  ex.on('error', (e) => { try { console.error('[交易所错误] ' + (e?.message || e)); } catch {} });
}

// ── AI 服务（哨兵/日报/分析/对话/出区间建议）────────────────────────────────
const aiService = createAiService({
  bots: { de: deBot, ex: exBot, rs: rsBot },
  exchanges: { de: deExchange, ex: exExchange, rs: rsExchange },
});
aiService.start();

// ── 多链钱包、充值验链与提现申请 ────────────────────────────────────────────
const bridgeService = createBridgeService({
  ...cfg.wallet.bridge,
  networks:cfg.wallet.networks,
  depositAddress:cfg.wallet.depositAddress,
});
const walletService = createWalletService({ ...cfg.wallet, dataRoot: DATA_ROOT, bridgeService, withdrawalPrivateKey: cfg.wallet.withdrawalPrivateKey });
const referralService = createReferralService({ database:walletService.database, walletService });
const withdrawalPayoutService = createWithdrawalPayoutService({
  walletService,
  networks:cfg.wallet.networks,
  withdrawalAddress:cfg.wallet.withdrawalAddress,
  privateKey:cfg.wallet.withdrawalPrivateKey,
  enabled:cfg.wallet.autoWithdrawalEnabled,
  isEnabled:() => walletService.withdrawalAutomationSettings().enabled,
  bridgeService,
  swap:cfg.wallet.swap,
});
const initialWithdrawalAutomation = walletService.withdrawalAutomationSettings();
if (initialWithdrawalAutomation.enabled && !withdrawalPayoutService.status().configured) {
  walletService.updateWithdrawalAutomationSettings({ ...initialWithdrawalAutomation, enabled:false });
}
withdrawalPayoutService.start();
const marketCatalog = createMarketCatalog({ dataRoot: DATA_ROOT });
// 美股代币行情适配：币安现货交易对为 {B}B+USDT（NVDABUSDT），永续为 {B}USDT（NVDAUSDT）
function catalogBinanceBase(coinInput, product) {
  const coin = String(coinInput || '').toUpperCase();
  const token = marketCatalog.get(coin);
  if (token?.category === 'stock' && product === 'spot') return `${coin}B`;
  return coin;
}
// 平台现货现价适配：入参/出参均使用展示符号（NVDAUSDT），内部改拉股票现货交易对（NVDABUSDT）
async function fetchCatalogSpotPrices(symbols, options = {}) {
  const displayByBinance = new Map();
  const bases = (Array.isArray(symbols) ? symbols : [symbols]).map(s => {
    const display = String(s || '').toUpperCase().replace(/USDT$/, '');
    const base = catalogBinanceBase(display, 'spot');
    displayByBinance.set(`${base}USDT`, display);
    return base;
  });
  const prices = await fetchPublicPrices(bases, options);
  const out = new Map();
  for (const [binanceSymbol, price] of prices) {
    const display = displayByBinance.get(binanceSymbol);
    out.set(display ? `${display}USDT` : binanceSymbol, price);
  }
  return out;
}
// 平台现货 WS 适配：订阅股票真实交易对，回调里把 symbol 还原成展示符号
function subscribeCatalogSpotPrices(displaySymbols, onPrice, onStatus) {
  const displayByBinance = new Map();
  const bases = displaySymbols.map(s => {
    const display = String(s || '').toUpperCase().replace(/USDT$/, '');
    const base = catalogBinanceBase(display, 'spot');
    displayByBinance.set(`${base}USDT`, display);
    return base;
  });
  return subscribePublicPrices(bases, (update) => {
    const display = displayByBinance.get(update.symbol);
    onPrice(display ? { ...update, symbol:`${display}USDT` } : update);
  }, onStatus);
}
const useLocalAdminDefaults = ['127.0.0.1', 'localhost', '::1'].includes(String(cfg.host || '').toLowerCase());
const adminAuth = createAdminAuth({
  username:process.env.PLATFORM_ADMIN_USERNAME || (useLocalAdminDefaults ? 'admin' : ''),
  password:process.env.PLATFORM_ADMIN_PASSWORD || (useLocalAdminDefaults ? 'WG-Admin-2026' : ''),
});
const agentAuth = createAgentAuth({ database: walletService.database });
const agentService = createAgentService({ walletService, referralService, database: walletService.database });
setPlatformSymbols(marketCatalog.symbols());
const platformService = createPlatformService({ dataRoot: DATA_ROOT, walletService });
platformService.setReferralService(referralService);
platformService.consolidateStrategyBalances();

// SSE 客户端集合（按交易所分组）
const deClients = new Set();
const exClients = new Set();
const rsClients = new Set();

// ── 工具函数 ──────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function send(res, code, obj) {
  const body = JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function safeTokenEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && right.length > 0 && crypto.timingSafeEqual(left, right);
}

function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function isLocalOperatorRequest(req) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  if (req.headers.forwarded || req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']) return false;
  try {
    const hostname = new URL(`http://${req.headers.host || ''}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch { return false; }
}

function requireOperator(req, res) {
  if (isLocalOperatorRequest(req)) return true;
  if (safeTokenEqual(req.headers['x-platform-admin-token'], cfg.operatorToken)) return true;
  send(res, 401, { error:'运营接口需要管理员认证', code:'OPERATOR_AUTH_REQUIRED' });
  return false;
}

function isOperatorPath(pathname) {
  return pathname === '/api/prices/stream'
    || pathname === '/api/overview' || pathname === '/api/overview/stream'
    || pathname === '/api/ledger' || pathname === '/api/ledger/export.csv'
    || pathname === '/api/env' || pathname.startsWith('/api/ai/') || pathname.startsWith('/api/operator/')
    || pathname.startsWith('/api/hyperliquid/')
    || ['/api/platform/stake', '/api/platform/unstake'].includes(pathname)
    || pathname.startsWith('/api/de/') || pathname.startsWith('/api/ex/') || pathname.startsWith('/api/rs/');
}

const rateBuckets = new Map();
const IP_LIKE_RE = /^[0-9a-f:.]{3,64}$/i;
// 本机 nginx 反代的 TCP 对端（回环）
function isProxyPeer(address) {
  const value = String(address || '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}
// 限频用的客户端标识：反代注入的真实 IP 优先（CF-Connecting-IP 由 Cloudflare 覆写，客户端无法伪造），
// 否则用 TCP 对端地址。若直接返回 socket 地址，所有用户会共用 nginx 的 127.0.0.1 导致互相挤爆限频桶。
function clientAddress(req) {
  const peer = String(req.socket.remoteAddress || 'unknown');
  if (isProxyPeer(peer)) {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (IP_LIKE_RE.test(cf)) return cf;
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (IP_LIKE_RE.test(forwarded)) return forwarded;
  }
  return peer;
}
function allowRequest(req, res, scope, limit, windowMs) {
  const now = Date.now();
  const key = `${scope}:${clientAddress(req)}`;
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) bucket = { count:0, resetAt:now + windowMs };
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count <= limit) return true;
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
  send(res, 429, { error:'请求过于频繁，请稍后重试', code:'RATE_LIMITED' });
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(key);
}, 60_000).unref?.();

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function requestError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let b = '', n = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > maxBytes) {
        done = true;
        reject(requestError('请求体过大', 413));
        return;
      }
      b += c;
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try { resolve(b ? JSON.parse(b) : {}); }
      catch { reject(requestError('JSON 请求体格式错误', 400)); }
    });
    req.on('error', (error) => {
      if (done) return;
      done = true;
      reject(requestError(error?.message || '读取请求体失败', 400));
    });
  });
}

const HYPERLIQUID_INFO_TYPES = new Set([
  'clearinghouseState', 'spotClearinghouseState', 'frontendOpenOrders',
  'userVaultEquities', 'referral', 'userFees', 'delegations',
  'delegatorSummary', 'validatorSummaries', 'allBorrowLendReserveStates', 'vaultSummaries',
  'spotMeta',
  'vaultDetails',
]);

async function hyperliquidInfo(body) {
  const response = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Hyperliquid API 返回 HTTP ${response.status}`);
  return response.json();
}

function readCookie(req, name) {
  const source = String(req.headers.cookie || '');
  for (const part of source.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); }
    catch { return ''; }
  }
  return '';
}

function walletSession(req) {
  return walletService.getSession(readCookie(req, 'wg_session'));
}

function sendIdleAccountResponse(res) {
  res.writeHead(204, { 'X-AxiX-Action':'idle', 'Cache-Control':'no-store' });
  return res.end();
}

function adminSession(req) {
  return adminAuth.session(readCookie(req, 'wg_admin_session'));
}

function isSameOrigin(req) {
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; }
  catch { return false; }
}

function setSessionCookie(req, res, token, maxAgeSeconds) {
  const forwardedProto = cfg.trustProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  const secure = Boolean(req.socket.encrypted) || forwardedProto === 'https';
  const value = token ? encodeURIComponent(token) : '';
  res.setHeader('Set-Cookie', `wg_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, maxAgeSeconds)}${secure ? '; Secure' : ''}`);
}

function setAdminSessionCookie(req, res, token, maxAgeSeconds) {
  const forwardedProto = cfg.trustProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  const secure = Boolean(req.socket.encrypted) || forwardedProto === 'https';
  const value = token ? encodeURIComponent(token) : '';
  res.setHeader('Set-Cookie', `wg_admin_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, maxAgeSeconds)}${secure ? '; Secure' : ''}`);
}

function agentSession(req) {
  return agentAuth.session(readCookie(req, 'wg_agent_session'));
}
function setAgentSessionCookie(req, res, token, maxAgeSeconds) {
  const forwardedProto = cfg.trustProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  const secure = Boolean(req.socket.encrypted) || forwardedProto === 'https';
  const value = token ? encodeURIComponent(token) : '';
  res.setHeader('Set-Cookie', `wg_agent_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, maxAgeSeconds)}${secure ? '; Secure' : ''}`);
}

const platformApi = createPlatformApi({
  platformService,
  fetchPrices: fetchCatalogSpotPrices,
  fetchFuturesPrices,
  send,
  readBody,
  getSession: walletSession,
});
const communityLinksApi = createCommunityLinksApi({
  service:createCommunityLinksService({dataRoot:DATA_ROOT}),
  send, readBody, getAdminSession:adminSession, isSameOrigin,
});
const internalStrategyService = createInternalStrategyService({
  dataRoot: DATA_ROOT,
  walletService,
  platformService,
  referralService,
  getMarkets: () => marketCatalog.list({ product:'perp' }),
  getMarkPrice: (product, symbol) => platformApi.marketPrice(product, symbol, { allowStale:true }),
});
const internalStrategyApi = createInternalStrategyApi({
  strategyService: internalStrategyService,
  fetchPrices: fetchFuturesPrices,
  fetchCandles: fetchFuturesCandles,
  analyzeTrend,
  send,
  readBody,
  getSession: walletSession,
  withAccountLock: platformApi.withAccountLock,
});
const referralApi = createReferralApi({ service:referralService, send, readBody, getSession:walletSession });
// ── A 币生态服务（需在 AI 跟单服务前创建：跟单开启要销毁 1000 枚 AIX）──
const aTokenService = createATokenService({ database: walletService.database, walletService });
const aiManagedService = createAiManagedService({
  platformService,
  walletService,
  fetchCandles: fetchPublicCandles,
  referralService,
  aTokenService,
});
const aiManagedApi = createAiManagedApi({
  service:aiManagedService,
  send,
  readBody,
  getSession:walletSession,
  withAccountLock:platformApi.withAccountLock,
});
// 跟单提现额度（2026-10-25）：USDT 提现占用跟单本金 30 天线性解锁的额度，驳回返还
walletService.setWithdrawalQuotaHook?.(aiManagedService.withdrawQuota);

// ── A 币赚取生态服务 ───────────────────────────────────────────────────────────
const bscNetworkCfg = (cfg.wallet.networks || []).find(n => n.id === 'bsc') || {};
// 注入 A 币现价：资产管理页把 OPEN 卖单锁定的 A 折算进总资产
platformService.setATokenPriceProvider(() => { try { return BigInt(aTokenService.getPriceUsdtUnits()); } catch { return 0n; } });
const aTokenPoolService = createATokenPoolService({
  aTokenService,
  // 市价卖报价按钱包直推阶梯费率（惰性求值：aTokenOrderService 在下方创建）
  sellFeeProfile: (wallet) => aTokenOrderService.sellFeeProfile(wallet),
});
// 轮换收款地址集合（含 A_TOKEN_ROTATION_ADDRESSES 的 '2:0x..' 套餐前缀）：
// 打到这些地址的激活属后台写入的虚拟数据，不计入上级看到的「激活矿机数」台数
const aTokenRotationAddresses = [...new Set([
  process.env.A_TOKEN_ROTATION_ADDRESS || '',
  ...String(process.env.A_TOKEN_ROTATION_ADDRESSES || '').split(',').map(entry => entry.split(':').pop()),
])].map(addr => String(addr || '').trim()).filter(Boolean).join(',');
// A_TOKEN_ROTATION_HIDE_VIEWERS：这些地址本人查看团队页时，其整棵下级里经轮换收款地址
// 确认的激活不计入「团队激活矿机」（如这条线最上面的号）；其他查看者不受影响。
const aTokenRotationHideViewers = String(process.env.A_TOKEN_ROTATION_HIDE_VIEWERS || '').trim();
const proReportingFile = path.join(DATA_ROOT, 'pro-reporting-exclusions.json');
const proReportingExclusions = fs.existsSync(proReportingFile) ? JSON.parse(fs.readFileSync(proReportingFile, 'utf8')) : null;
const aTokenTeamService = createATokenTeamService({ database: walletService.database, walletService, rotationAddresses: aTokenRotationAddresses, rotationHideViewers: aTokenRotationHideViewers, reportingExclusions: proReportingExclusions });
const aTokenMinerService = createATokenMinerService({ aTokenService, database: walletService.database, teamService: aTokenTeamService });
const aTokenStakingService = createATokenStakingService({ aTokenService, database: walletService.database, teamService: aTokenTeamService });
const aTokenTransferService = createATokenTransferService({ aTokenService, database: walletService.database, referralService, teamService: aTokenTeamService, walletService });
const aTokenActivationService = createATokenActivationService({
  aTokenService, minerService: aTokenMinerService, database: walletService.database,
  rpcUrl: bscNetworkCfg.rpcUrl || process.env.BSC_RPC_URL || '',
  collectionAddress: process.env.A_TOKEN_COLLECTION_ADDRESS || '',
  confirmations: Number(process.env.A_TOKEN_ACTIVATION_CONFIRMATIONS || 12),
  // 收款地址轮换：rotationPlan 指定参与轮换的套餐（逗号分隔，如 '1,2' 表示 0.002 与 0.05 都轮换）
  // rotationEvery=N 表示每 N 笔中的第 N 笔充到轮换地址，其余进主地址（N=2 即主/轮换交替）
  // A_TOKEN_ROTATION_ADDRESSES 可为每个套餐指定专属轮换地址（'1:0x..,2:0x..'），未单列的套餐用 A_TOKEN_ROTATION_ADDRESS
  // 默认关闭（A_TOKEN_ROTATION_ADDRESS 为空）；需要启用时在 .env 设置
  rotationAddress: process.env.A_TOKEN_ROTATION_ADDRESS || '',
  rotationAddressesByPlan: process.env.A_TOKEN_ROTATION_ADDRESSES || '',
  rotationPlan: process.env.A_TOKEN_ROTATION_PLAN || '2',
  rotationEvery: Number(process.env.A_TOKEN_ROTATION_EVERY || 3),
  // 每个套餐独立的轮换间隔（'1:3,2:2' 表示 0.002 套餐 3 进 1、0.05 套餐 2 进 1）；
  // 未单列的套餐回退到 A_TOKEN_ROTATION_EVERY
  rotationEveryByPlan: process.env.A_TOKEN_ROTATION_EVERY_BY_PLAN || '',
  // 链上收款对账（兜底漏单）：增量扫描收款地址，自动补录"链上已付、站内无记录"的付款
  reconcileLookbackBlocks: Number(process.env.A_TOKEN_RECONCILE_LOOKBACK_BLOCKS || 5000),
  reconcileRangeCap: Number(process.env.A_TOKEN_RECONCILE_RANGE_CAP || 2000),
  reconcileConcurrency: Number(process.env.A_TOKEN_RECONCILE_CONCURRENCY || 8),
  extraCollectionAddresses: process.env.A_TOKEN_RECONCILE_EXTRA_ADDRESSES || '',
  // 积分在服务内部 confirm() 汇聚点发放（惰性引用：lotteryService 在下方创建）
  onConfirmed: (wallet, plan) => lotteryService.onMinerActivated(wallet, plan),
});
// 启动 pending 激活记录的自动链上校验:确认达标自动发矿机,无需用户或后台手动操作
aTokenActivationService.startAutoVerify(Number(process.env.A_TOKEN_ACTIVATION_AUTO_VERIFY_MS || 30_000));
// 启动链上收款对账:兜底前端 POST 失败导致的漏单(链上已付款但站内无记录)
aTokenActivationService.startOnchainReconcile(Number(process.env.A_TOKEN_RECONCILE_MS || 60_000));
const aTokenOrderService = createATokenOrderService({
      aTokenService,
      database: walletService.database, teamService: aTokenTeamService,
      referralService,
      // 撮合同价档内：买单始终小额优先（金额小者先成交）；卖单默认按挂单时间先来先成交，
      // 每 W 次撮合尝试中有 C 次走小额轮（卖单也按金额小者优先）= 默认 10 次里 3 次
      matchSmallFirstWindow: Number(process.env.A_TOKEN_MATCH_SMALL_FIRST_WINDOW || 10),
      matchSmallFirstCount: Number(process.env.A_TOKEN_MATCH_SMALL_FIRST_COUNT || 3),
    });
const aTokenKlineService = createATokenKlineService({
  database: walletService.database, aTokenService, orderService: aTokenOrderService,
});
// 启动时若任一周期 K 线 < 30 根 → 自动播种种子历史 K 线
try { aTokenKlineService.ensureSeeded(); } catch (e) { console.error('[A币K线] 初始化种子失败', e?.message || e); }
// A 币链上提现服务（BSC 单链，依赖 A_TOKEN_CONTRACT_ADDRESS + A_TOKEN_HOT_WALLET + A_TOKEN_HOT_PRIVATE_KEY）
const aTokenWithdrawalService = createATokenWithdrawalService({
  aTokenService,
  walletService,
  database: walletService.database,
  contractAddress: process.env.A_TOKEN_CONTRACT_ADDRESS || '',
  hotWalletAddress: process.env.A_TOKEN_HOT_WALLET || '',
  hotPrivateKey: process.env.A_TOKEN_HOT_PRIVATE_KEY || '',
  rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
  pollIntervalMs: Number(process.env.A_TOKEN_WITHDRAWAL_POLL_MS || 15_000),
  // 全部自动放款，不做大额人工审核（只要用户内盘 A 余额够 + 平台热钱包链上有 A 就直接出款）
  autoApproveThresholdA: Number.MAX_SAFE_INTEGER,
});
try { aTokenWithdrawalService.start(); } catch (e) { console.error('[A币提现] 启动失败', e?.message || e); }
// AIX 链上提取签名服务（AIXPool harvest 模式，用户付 Gas）
// 依赖：AIX_POOL_CONTRACT_ADDRESS（已部署的 AIXPool 合约地址）
//       AIX_POOL_SIGNER_PRIVATE_KEY（平台签名私钥，对应合约里的 platformSigner）
const aTokenClaimService = createATokenClaimService({
  aTokenService,
  walletService,
  rpcUrl: cfg.wallet.networks.find(network => network.chainId === Number(process.env.BSC_CHAIN_ID || 56))?.rpcUrl,
  confirmations: Number(process.env.BSC_CONFIRMATIONS || 15),
  database: walletService.database,
  contractAddress: process.env.AIX_POOL_CONTRACT_ADDRESS || '',
  signerPrivateKey: process.env.AIX_POOL_SIGNER_PRIVATE_KEY || '',
  chainId: Number(process.env.BSC_CHAIN_ID || 56),
});
// 仅统计待核对记录；旧合约授权不按本地时间过期，禁止超时退款。
try {
  const swept = aTokenClaimService.sweepStaleClaims();
  if (swept.refunded > 0) console.log(`[AIX提取] 启动时回滚 ${swept.refunded} 条过期 claim`);
} catch (e) { console.error('[AIX提取] 启动回滚失败', e?.message || e); }
// 每小时检查待核对记录，不退回仍可能在链上领取的资金。
setInterval(() => {
  try { aTokenClaimService.sweepStaleClaims(); } catch (e) { /* silent */ }
}, 60 * 60_000).unref?.();
// 积分抽奖服务
const lotteryService = createLotteryService({
  database: walletService.database, walletService, platformService, referralService,
});
// 空投积分（独立于抽奖积分，参考 Hyperliquid Points：有效成交量计分 + 对敲剔除 + 周快照）
const airdropPointsService = createAirdropPointsService({ database: walletService.database });
platformService.setPointsService(airdropPointsService);
aiManagedService.setPointsService?.(airdropPointsService);
// Hyperliquid 式周结算：启动补算历史周 + 每 10 分钟轮询跨周结算
try { airdropPointsService.settleDue(); } catch (e) { console.warn('[空投积分] 启动结算失败:', e?.message || e); }
const airdropSettleTimer = setInterval(() => { try { airdropPointsService.settleDue(); } catch {} }, 10 * 60_000);
airdropSettleTimer.unref?.();
const lotteryApi = createLotteryApi({
  lotteryService, send, readBody, getSession: walletSession,
  adminOnly: (req, res) => {
    const s = adminSession(req);
    if (!s) { send(res, 401, { error:'后台登录已失效，请重新登录', code:'ADMIN_AUTH_REQUIRED' }); return false; }
    return true;
  },
});
const aTokenApi = createATokenApi({
      aTokenService, poolService: aTokenPoolService, minerService: aTokenMinerService,
      stakingService: aTokenStakingService, transferService: aTokenTransferService, activationService: aTokenActivationService,
      klineService: aTokenKlineService, orderService: aTokenOrderService, withdrawalService: aTokenWithdrawalService,
      claimService: aTokenClaimService,
      walletService, teamService: aTokenTeamService,
      send, readBody, getSession: walletSession, withAccountLock: platformApi.withAccountLock,
    });
// 奔跑吧 AIX 押注经济（自选押注 + 距离阶梯返还 + 1% 流水转可卖额度）
const runAixGameApi = createRunAixGameApi({
  aTokenService, database: walletService.database,
  send, readBody, getSession: walletSession, withAccountLock: platformApi.withAccountLock,
});
// 哈希星盘 AIX 押注（commit-reveal 公平架构 + 1% 流水转可卖额度）
const hashAixGameApi = createHashAixGameApi({
  aTokenService, database: walletService.database,
  send, readBody, getSession: walletSession, withAccountLock: platformApi.withAccountLock,
});
const aTokenAdminApi = createATokenAdminApi({
  aTokenService, poolService: aTokenPoolService, minerService: aTokenMinerService,
  stakingService: aTokenStakingService, activationService: aTokenActivationService,
  klineService: aTokenKlineService, orderService: aTokenOrderService, walletService,
  aTokenTeamService,
  send, readBody,
});
// 在线客服：用户端 + 后台回复
const supportService = createSupportService({
  database: walletService.database,
  // 客服检测到攻击载荷时，直接把该钱包写入平台封禁名单并踢掉其会话
  blockWallet: (address, reason) => walletService.blockWallet(address, reason),
});
const supportApi = createSupportApi({ service: supportService, send, readBody, getSession: walletSession });
const fundsAdminApi = createFundsAdminApi({ walletService, minerService:aTokenMinerService, payoutService:withdrawalPayoutService, send, readBody, isSameOrigin, allowRequest, getToken:() => String(process.env.WALLET_ADMIN_TOKEN || '') });
// ── 60s 定时：矿机产出 + 质押日结 + 每日固定销毁跨日结算 ──
// 2026-10-29：团伙深链曾使团队全量快照递归爆栈、O(N²) 自旋卡死（23:23 与 00:11 两次全站无响应）。
// 已修复：teamHeldOf 改迭代式 + 全链路剔除封禁账号（见 a-token-team-service.js），团队任务恢复启用。
const TEAM_JOBS_ENABLED = true;
const aTokenMinerTimer = setInterval(() => {
  try { aTokenMinerService.processAll(); } catch (e) { console.error('[A币矿机]', e?.message || e); }
  try { aTokenService.settleDailyBurn(); } catch (e) { console.error('[A币每日销毁]', e?.message || e); }
}, 60_000);
const aTokenStakeTimer = setInterval(() => {
  try { aTokenStakingService.processAll(); } catch (e) { console.error('[A币质押]', e?.message || e); }
}, 60_000);
// 20s 定时：K 线实时推进 + 价格联动
const aTokenKlineTimer = setInterval(() => {
  try { aTokenKlineService.tickLiveBar(); } catch (e) { console.error('[A币K线] tick失败', e?.message || e); }
}, 20_000);
aTokenMinerTimer.unref?.();
aTokenStakeTimer.unref?.();
aTokenKlineTimer.unref?.();

// 5 分钟定时：团队等级快照（O(n) 建树记忆化，前端团队页只读快照，不做实时递归）
const aTokenTeamSnapshotTimer = setInterval(() => {
  if (!TEAM_JOBS_ENABLED) return;
  try {
    const r = aTokenTeamService.snapshotAll();
    console.log('[团队快照] 已更新', r.count, '个用户等级');
  } catch (e) { console.error('[团队快照]', e?.message || e); }
}, 5 * 60_000);
// 每天 00:00（北京时间）定时：平级奖日结 + A10 均分池日结
// 0:00-0:04 为容错窗口（错过整点也能补跑），但按北京日去重，整组任务当天只执行一次，
// 避免窗口内每分钟重复扫描 6000+ 台矿机/全量聚合造成的叠加负载（2026-10-12 0 点卡死优化）
let _dailySettleDoneDay = '';
const aTokenA10SettleTimer = setInterval(() => {
  const now = new Date(Date.now() + 8 * 3600_000);
  const bjDay = now.toISOString().slice(0, 10);
  if (now.getUTCHours() === 0 && now.getUTCMinutes() < 5 && _dailySettleDoneDay !== bjDay) {
    // 先处理前一天最后一批矿机/质押产出，再结算，保证基数完整
    try { aTokenMinerService.processAll(); } catch (e) { console.error('[A币矿机]', e?.message || e); }
    try { aTokenStakingService.processAll(); } catch (e) { console.error('[A币质押]', e?.message || e); }
    try {
      const r = TEAM_JOBS_ENABLED ? aTokenTeamService.settleParityRewards() : null;
      if (r?.settled) console.log('[平级奖日结] daySlot', r.daySlot, r.count, '条，合计', r.totalA, 'AIX');
    } catch (e) { console.error('[平级奖日结]', e?.message || e); }
    try {
      const r = TEAM_JOBS_ENABLED ? aTokenTeamService.settleA10Pool() : null;
      if (r?.settled) console.log('[A10池日结]', r.settleDate, '人均', r.perShare, 'A10人数', r.participantCount);
    } catch (e) { console.error('[A10池日结]', e?.message || e); }
    // 全部步骤完成后再标记；各步骤均已 try/catch 不会冒泡，标记仅用于跳过窗口内的重复空跑
    _dailySettleDoneDay = bjDay;
  }
}, 60_000);
aTokenTeamSnapshotTimer.unref?.();
aTokenA10SettleTimer.unref?.();
// 启动时先跑一次快照（团队任务停用期间跳过）
if (TEAM_JOBS_ENABLED) { try { aTokenTeamService.snapshotAll(); } catch (e) { console.error('[团队快照] 启动失败', e?.message || e); } }
// 启动时补跑平级奖日结：幂等，前一天已结算则快速跳过；重启/宕机错过 0 点窗口时自动补发
if (TEAM_JOBS_ENABLED) {
  try {
    const r = aTokenTeamService.settleParityRewards();
    if (r?.settled) console.log('[平级奖日结] 启动补发 daySlot', r.daySlot, r.count, '条，合计', r.totalA, 'AIX');
  } catch (e) { console.error('[平级奖日结] 启动补发失败', e?.message || e); }
}

let platformSpotFeed = null;
let platformRiskFeed = null;
function restartPlatformMarketFeeds() {
  platformSpotFeed?.unsubscribe?.();
  platformRiskFeed?.unsubscribe?.();
  const spotSymbols = marketCatalog.symbols('spot');
  const perpSymbols = marketCatalog.symbols('perp');
  platformSpotFeed = spotSymbols.length ? subscribeCatalogSpotPrices(spotSymbols, (update) => {
    try { platformApi.updateMarket(update); }
    catch (error) { console.error('[平台风控]', error?.message || error); }
  }) : null;
  platformRiskFeed = perpSymbols.length ? subscribeFuturesPrices(perpSymbols, (update) => {
    try { platformApi.updateMarket(update); }
    catch (error) { console.error('[平台合约风控]', error?.message || error); }
    internalStrategyService.processPrice(update?.symbol, update?.price).catch((error) => console.error('[内部策略]', error?.message || error));
  }) : null;
}
restartPlatformMarketFeeds();

// Keep contract risk controls and internal strategies moving when the Binance
// WebSocket is blocked or stale. Liquidation must never depend on a browser view.
let internalStrategyFallbackBusy = false;
let internalStrategyFailCount = 0;
const internalStrategyFallbackTimer = setInterval(async () => {
  if (internalStrategyFallbackBusy) return;
  internalStrategyFallbackBusy = true;
  try {
    const symbols = marketCatalog.symbols('perp');
    const prices = await fetchFuturesPrices(symbols, { timeoutMs:10000 });
    internalStrategyFailCount = 0;
    const receivedAt = Date.now();
    for (const symbol of symbols) {
      const price = Number(prices.get(`${symbol}USDT`) || prices.get(symbol) || 0);
      if (!(price > 0)) continue;
      platformApi.updateMarket({ product:'perp', symbol, price, priceType:'mark', receivedAt });
      await internalStrategyService.processPrice(symbol, price);
    }
  } catch (error) {
    // 行情兜底失败属预期内（代理偶发抖动 / Binance API 限流），仅连续失败时才告警，
    // 避免每次单次超时都刷错误日志。
    internalStrategyFailCount += 1;
    if (internalStrategyFailCount >= 3) {
      console.warn('[内部策略行情兜底] 连续失败 ' + internalStrategyFailCount + ' 次，重建代理连接...', error?.message || error);
      try {
        await setupProxies(cfg);
        console.log('[内部策略行情兜底] 代理连接已重建');
      } catch (e) {
        console.error('[内部策略行情兜底] 重建代理失败：', e?.message || e);
      }
      internalStrategyFailCount = 0;
    }
  } finally {
    internalStrategyFallbackBusy = false;
  }
}, 10000);
internalStrategyFallbackTimer.unref?.();

function marketPricesFor(exchange) {
  const priceMap = exchange.prices instanceof Map
    ? exchange.prices
    : exchange._prices instanceof Map ? exchange._prices : null;
  if (!priceMap) return {};

  return Object.fromEntries(
    [...priceMap.entries()]
      .map(([marketId, price]) => [String(marketId), Number(price)])
      .filter(([, price]) => Number.isFinite(price) && price > 0),
  );
}

function stateWithMarketPrices(bot, exchange, exchangeKey = null) {
  const state = bot.getState();
  if (exchangeKey) state.exchange = exchangeKey;
  state.marketPrices = marketPricesFor(exchange);
  return state;
}

// ── 交易所路由处理器工厂 ───────────────────────────────────────────────────────
function makeExchangeHandler(prefix, bot, exchange, exCfg, clients, name) {
  const exchangeKey = prefix.split('/').pop();
  return async (req, res, subPath, url) => {
    if (subPath === '/markets') {
      return send(res, 200, {
        exchange: name,
        mode: exCfg.mode,
        dataSource: exchange.dataSource || (exCfg.mode === 'live' ? 'real' : 'synthetic'),
        dataProvider: exchange.dataProvider || null,
        network: exchange.network || exCfg.network,
        apiUrl: exchange.apiUrl || exCfg.apiUrl,
        markets: await exchange.getMarkets(),
      });
    }

    if (subPath === '/trend') {
      const marketId = Number(url.searchParams.get('marketId') || 1);
      const intervalSec = Number(url.searchParams.get('intervalSec') || 3600);
      let candles = [];
      let price = null;
      try { price = await exchange.getPrice(marketId); } catch {}
      try {
        const market = (await exchange.getMarkets()).find((item) => Number(item.marketId) === marketId);
        const symbol = market?.publicSymbol || market?.symbol || market?.displayName || market?.name;
        candles = symbol ? await fetchPublicCandles(symbol, intervalSec, 200) : [];
      } catch {
        try { candles = await exchange.getCandles(marketId, intervalSec, 200); } catch { /* tolerate */ }
      }
      const analysis = (candles && candles.length >= 20)
        ? analyzeTrend(candles, { currentPrice: price })
        : {
            trend: 'range', recommended: 'neutral', strength: 0, atrPct: null, price,
            detail: '暂时拿不到足够K线数据，已默认中性网格。可手动设置上下边界后启动；不影响下单。',
          };
      return send(res, 200, { analysis, candles: (candles || []).slice(-120) });
    }

    if (subPath === '/state') return send(res, 200, stateWithMarketPrices(bot, exchange, exchangeKey));

    if (subPath === '/start' && req.method === 'POST') {
      try { return send(res, 200, await bot.start(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/stop' && req.method === 'POST') {
      try { return send(res, 200, await bot.stop(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/adjust' && req.method === 'POST') {
      try { return send(res, 200, await bot.adjustRange(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/reset' && req.method === 'POST') {
      try { return send(res, 200, await bot.resetStats()); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/cancel-orders' && req.method === 'POST') {
      try { return send(res, 200, await bot.cancelAllOrders()); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/start-recovery' && req.method === 'POST') {
      try { return send(res, 200, await bot.startRecovery(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    // 重新与交易所建立连接：重建客户端/解卡轮询/重启轮询循环。
    // 不撤单、不平仓、不动网格状态 —— 挂单照常被跟踪；重连成功后立刻对账一次。
    // 若该所启动时未连上导致续跑被跳过（快照仍为运行状态），重连成功后自动续跑接管挂单。
    if (subPath === '/reconnect' && req.method === 'POST') {
      try {
        if (typeof exchange.reconnect === 'function') await exchange.reconnect();
        else if (typeof exchange.init === 'function') await exchange.init();
        let resumed = false, resumeError = null;
        if (!bot.running) {
          const key = prefix.split('/').pop(); // '/api/ex' -> 'ex'
          const snap = loadSnapshot(key);
          if (snap?.running && snap?.config) {
            try {
              // marketId 是按连接会话编号的，可能已漂移：按市场名称重新解析
              const markets = await exchange.getMarkets();
              const norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
              const m = markets.find((x) => norm(x.displayName) === norm(snap.config.displayName) || norm(x.name) === norm(snap.config.displayName));
              if (m) snap.config.marketId = m.marketId;
              await bot.resume(snap);
              resumed = true;
              console.log(`[恢复] ${key.toUpperCase()} 重连成功后已自动续跑，接管挂单并完成对账。`);
            } catch (e) {
              resumeError = e?.message || String(e); // 续跑失败不撤单：挂单保留，可重启程序再试
              console.error(`[恢复] ${key.toUpperCase()} 重连后续跑失败（${resumeError}），挂单保留未动。`);
            }
          }
        }
        if (bot.running) await bot.reconcileOpenOrders().catch(() => {});
        return send(res, 200, { ok: true, resumed, resumeError, state: bot.getState() });
      } catch (e) {
        return send(res, 500, { error: e?.message || String(e) });
      }
    }

    if (subPath === '/close-position' && req.method === 'POST') {
      try { const b = await readBody(req); return send(res, 200, await bot.closePositionNow(b && b.marketId)); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(stateWithMarketPrices(bot, exchange, exchangeKey))}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    send(res, 404, { error: 'not found: ' + subPath });
  };
}

const deHandler = makeExchangeHandler('/api/de', deBot, deExchange, cfg.de, deClients, 'Decibel');
const exHandler = makeExchangeHandler('/api/ex', exBot, exExchange, cfg.ex, exClients, 'Extended');
const rsHandler = makeExchangeHandler('/api/rs', rsBot, rsExchange, cfg.rs, rsClients, 'RISEx');

// 游戏页需要被站内「游戏生态」弹层以同源 iframe 嵌入，其余页面维持禁止嵌入
const GAME_PAGE_PATHS = new Set(['/games.html', '/run-aix.html', '/hash-aix.html', '/run-aix-classic.html', '/run-aix-config.html']);

// ── HTTP 服务器 ───────────────────────────────────────────────────────────────
export const server = http.createServer(async (request, res) => {
  const url = new URL(request.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/' && url.searchParams.get('admin') === '1') {
      res.writeHead(302, { Location:'/', 'Cache-Control':'no-store' });
      return res.end();
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://bin.bnbstatic.com; connect-src 'self' https://api.hyperliquid.xyz https://stats-data.hyperliquid.xyz https://cloudflareinsights.com; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
    if (GAME_PAGE_PATHS.has(p.toLowerCase())) {
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'");
    }
    const adminKind = adminPageKind(p);
    if (adminKind) {
      res.setHeader('Content-Security-Policy', adminKind === 'funds' ? FUNDS_ADMIN_CSP : OPERATOR_ADMIN_CSP);
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cache-Control', 'no-store');
    }
    if (adminKind === 'funds' && decodeURIComponent(p).replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase() === '/withdraw-admin.html') {
      res.writeHead(302, { Location:'/funds-admin.html', 'Cache-Control':'no-store' });
      return res.end();
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !isSameOrigin(request)) {
      return send(res, 403, { error:'拒绝跨站修改请求' });
    }
    // Reject restricted wallet requests before any user API can read or mutate account state.
    // Administrative authentication is independent of the user's wallet cookie.
    if (p.startsWith('/api/') && !p.startsWith('/api/admin/') && !p.startsWith('/api/wallet/admin/')
      && !p.startsWith('/api/operator/') && walletService.isSilentSessionBlocked(readCookie(request, 'wg_session'))) {
      return sendIdleAccountResponse(res);
    }
    if (p.startsWith('/api/wallet/admin/')) return fundsAdminApi.handle(request, res, p);
    if (p === '/api/admin/login' && request.method === 'POST') {
      if (!allowRequest(request, res, 'admin-login', 10, 15 * 60_000)) return;
      try {
        const body = await readBody(request, 16_000);
        const login = adminAuth.login(body.username, body.password);
        const maxAge = Math.max(0, Math.floor((login.expiresAt - Date.now()) / 1000));
        setAdminSessionCookie(request, res, login.token, maxAge);
        return send(res, 200, { authenticated:true, username:login.username, expiresAt:new Date(login.expiresAt).toISOString() });
      } catch (error) {
        return send(res, Number(error?.statusCode) || 401, { error:error?.message || '登录失败' });
      }
    }
    if (p === '/api/admin/session' && request.method === 'GET') {
      const session = adminSession(request);
      return send(res, 200, session
        ? { authenticated:true, username:session.username, expiresAt:new Date(session.expiresAt).toISOString() }
        : { authenticated:false });
    }
    if (p === '/api/admin/logout' && request.method === 'POST') {
      adminAuth.logout(readCookie(request, 'wg_admin_session'));
      setAdminSessionCookie(request, res, '', 0);
      return send(res, 200, { ok:true });
    }
    // ── 代理后台（只读，按绑定钱包下级过滤） ─────────────────────────────
    if (p === '/api/agent/login' && request.method === 'POST') {
      if (!allowRequest(request, res, 'agent-login', 10, 15 * 60_000)) return;
      try {
        const body = await readBody(request, 16_000);
        const login = agentAuth.login(body.username, body.password);
        const maxAge = Math.max(0, Math.floor((login.expiresAt - Date.now()) / 1000));
        setAgentSessionCookie(request, res, login.token, maxAge);
        return send(res, 200, { authenticated:true, username:login.username, walletAddress:login.walletAddress, expiresAt:new Date(login.expiresAt).toISOString() });
      } catch (error) {
        return send(res, Number(error?.statusCode) || 401, { error:error?.message || '登录失败' });
      }
    }
    if (p === '/api/agent/session' && request.method === 'GET') {
      const session = agentSession(request);
      return send(res, 200, session
        ? { authenticated:true, username:session.username, walletAddress:session.walletAddress, expiresAt:new Date(session.expiresAt).toISOString() }
        : { authenticated:false });
    }
    if (p === '/api/agent/logout' && request.method === 'POST') {
      agentAuth.logout(readCookie(request, 'wg_agent_session'));
      setAgentSessionCookie(request, res, '', 0);
      return send(res, 200, { ok:true });
    }
    if (p.startsWith('/api/agent/')) {
      const session = agentSession(request);
      if (!session) return send(res, 401, { error:'代理登录已失效，请重新登录', code:'AGENT_AUTH_REQUIRED' });
      if (p === '/api/agent/dashboard' && request.method === 'GET') return send(res, 200, agentService.dashboard(session.walletAddress));
      if (p === '/api/agent/users' && request.method === 'GET') return send(res, 200, { users: agentService.users(session.walletAddress) });
      if (p === '/api/agent/deposits' && request.method === 'GET') return send(res, 200, { rows: agentService.deposits(session.walletAddress, url.searchParams.get('status') || '') });
      if (p === '/api/agent/withdrawals' && request.method === 'GET') return send(res, 200, { rows: agentService.withdrawals(session.walletAddress, url.searchParams.get('status') || '') });
      if (p === '/api/agent/rewards' && request.method === 'GET') return send(res, 200, agentService.referralRewards(session.walletAddress));
      return send(res, 404, { error:'代理接口不存在' });
    }
    if (p.startsWith('/api/admin/')) {
      if (await communityLinksApi.handle(request, res, p)) return;
      const operatorSession = adminSession(request);
      if (!adminSession(request)) return send(res, 401, { error:'后台登录已失效，请重新登录', code:'ADMIN_AUTH_REQUIRED' });
      if (isLegacyFundsPath(p)) return send(res, 403, { error:'此操作已移至独立资金后台，请单独验证资金权限', code:'FUNDS_ADMIN_REQUIRED' });
      if (await supportApi.handleAdmin(request, res, p)) return;
      if (await aTokenAdminApi.handle(request, res, p, { operatorSession, url, allowRequest })) return;
      if (await lotteryApi.handle(request, res, p)) return;
      // 手动触发平级奖 + A10 池日结（幂等；服务重启错过 0 点窗口时补发用）
      if (p === '/api/admin/a-token/settle-daily' && request.method === 'POST') {
        if (!allowRequest(request, res, 'a-token-admin', 10, 60_000)) return;
        try {
          try { aTokenMinerService.processAll(); } catch (e) { console.error('[A币矿机]', e?.message || e); }
          try { aTokenStakingService.processAll(); } catch (e) { console.error('[A币质押]', e?.message || e); }
          const parity = aTokenTeamService.settleParityRewards();
          const a10 = aTokenTeamService.settleA10Pool();
          console.log('[手动日结] 平级奖', JSON.stringify(parity), 'A10', JSON.stringify(a10));
          return send(res, 200, { ok: true, parity, a10 });
        } catch (error) { return send(res, 400, { error: error?.message || String(error) }); }
      }
      // ── Admin 代理账号管理 ──────────────────────────────────────
      if (p === '/api/admin/agents' && request.method === 'GET') {
        const agents = walletService.database.listAgents().map(({ passwordHash, ...rest }) => rest);
        return send(res, 200, { agents });
      }
      if (p === '/api/admin/agents' && request.method === 'POST') {
        try {
          const body = await readBody(request, 16_000);
          const username = String(body.username || '').trim();
          const password = String(body.password || '');
          const walletAddress = String(body.walletAddress || '').trim().toLowerCase();
          if (username.length < 3) return send(res, 400, { error:'用户名至少 3 个字符' });
          if (password.length < 6) return send(res, 400, { error:'密码至少 6 个字符' });
          if (!walletAddress) return send(res, 400, { error:'绑定钱包地址不能为空' });
          if (walletService.database.getAgentByUsername(username)) return send(res, 409, { error:'该用户名已存在' });
          const id = crypto.randomUUID();
          const created = walletService.database.createAgent({ id, username, passwordHash: hashPassword(password), walletAddress, createdBy: operatorSession.username });
          const { passwordHash, ...agent } = created;
          return send(res, 201, agent);
        } catch (error) { return send(res, Number(error?.statusCode) || 400, { error:error?.message || String(error) }); }
      }
      if (p.startsWith('/api/admin/agents/')) {
        const id = decodeURIComponent(p.split('/')[4] || '');
        const sub = p.split('/').slice(5).join('/');
        if (!id) return send(res, 400, { error:'代理 ID 不能为空' });
        const agent = walletService.database.getAgentById(id);
        if (!agent) return send(res, 404, { error:'代理不存在' });
        // 改状态：POST /api/admin/agents/{id}/status { status: 'active'|'disabled' }
        if (sub === 'status' && request.method === 'POST') {
          try {
            const body = await readBody(request, 8_000);
            const r = walletService.database.updateAgentStatus(id, body.status);
            if (body.status === 'disabled') agentAuth.invalidateByAgentId(id);
            return send(res, 200, r);
          } catch (error) { return send(res, Number(error?.statusCode) || 400, { error:error?.message || String(error) }); }
        }
        // 重置密码：POST /api/admin/agents/{id}/password { password }
        if (sub === 'password' && request.method === 'POST') {
          const body = await readBody(request, 8_000);
          const password = String(body.password || '');
          if (password.length < 6) return send(res, 400, { error:'密码至少 6 个字符' });
          return send(res, 200, walletService.database.updateAgentPassword(id, hashPassword(password)));
        }
        // 改绑定钱包：POST /api/admin/agents/{id}/wallet { walletAddress }
        if (sub === 'wallet' && request.method === 'POST') {
          const body = await readBody(request, 8_000);
          const walletAddress = String(body.walletAddress || '').trim().toLowerCase();
          if (!walletAddress) return send(res, 400, { error:'钱包地址不能为空' });
          return send(res, 200, walletService.database.updateAgentWallet(id, walletAddress));
        }
        // 删除：DELETE /api/admin/agents/{id}
        if (!sub && request.method === 'DELETE') {
          agentAuth.invalidateByAgentId(id);
          return send(res, 200, walletService.database.deleteAgent(id));
        }
      }
      if (p === '/api/admin/dashboard' && request.method === 'GET') {
        const walletDashboard = walletService.adminDashboard({ includeUsers:url.searchParams.get('view') !== 'overview' });
        return send(res, 200, {
          ...walletDashboard,
          withdrawalAutomation:{ ...walletDashboard.withdrawalAutomation, ...withdrawalPayoutService.status() },
          tokens:marketCatalog.list({ includeDisabled:true }),
          recentDeposits:walletService.adminListDeposits('', { limit:8 }),
          recentWithdrawals:walletService.adminListWithdrawals('', { limit:8 }),
        });
      }
      if (p === '/api/admin/users' && request.method === 'GET') {
        const dashboard = walletService.adminDashboard({
          userQuery:url.searchParams.get('q') || '', realOnly:url.searchParams.get('realOnly') === '1',
          ...(url.searchParams.has('limit') ? { limit:url.searchParams.get('limit'), offset:url.searchParams.get('offset') } : {}),
        });
        return send(res, 200, { summary:dashboard.summary, users:dashboard.users,
          ...(dashboard.usersTotal !== undefined ? { total:dashboard.usersTotal, limit:dashboard.usersLimit, offset:dashboard.usersOffset } : {}),
        });
      }
      // 用户完整数据详情：矿机/质押/激活/直推间推团队/交易/互转
      if (p.startsWith('/api/admin/users/') && p.endsWith('/detail') && request.method === 'GET') {
        try {
          const wallet = decodeURIComponent(p.split('/')[4] || '').toLowerCase();
          if (!wallet) return send(res, 400, { error:'钱包地址不能为空' });
          const db = walletService.database;
          const fmtA = v => { try { return formatUnits(BigInt(v || '0'), A_TOKEN_DECIMALS); } catch { return '0'; } };
          const fmtU = v => { try { return formatUnits(BigInt(v || '0'), 6); } catch { return '0'; } };
          // 基本信息
          const walletUser = walletService.ensureUser(wallet);
          const usdtBalance = fmtU(walletUser.balances?.USDT || '0');
          const aixBalance = aTokenService.balanceA(wallet);
          const level = walletUser.level || 1;
          // 个人业绩 & 团队业绩（来自团队快照）
          const teamLevelRow = db.getATokenTeamLevel(wallet) || {};
          const personalHeld = fmtA(teamLevelRow.personalHeldUnits || '0');
          const teamHeld = fmtA(teamLevelRow.teamHeldUnits || '0');
          // 等级以团队快照为准（无快照=未达标=0级）
          const teamLevel = Number(teamLevelRow.level || 0);
          // 推荐关系
          const links = db.listReferralLinks();
          const link = links.find(l => String(l.wallet).toLowerCase() === wallet) || null;
          const referrerWallet = link?.referrerWallet || null;
          // 矿机（格式化 AIX 18 位小数为可读数值）
          const miners = db.listATokenMiners(wallet).map(m => ({ ...m,
            totalUnits: fmtA(m.totalUnits),
            totalEarnedUnits: fmtA(m.totalEarnedUnits),
            dayEarnedUnits: fmtA(m.dayEarnedUnits),
            dailyTargetUnits: fmtA(m.dailyTargetUnits),
          }));
          // 全历史统计；列表单独限制条数，质押利息与返还本金分开。
          const aixIncome = readAdminAixIncome(db, wallet);
          // 激活记录
          const activations = db.listATokenActivationsByWallet(wallet);
          // 直推列表（带激活统计）
          const directs = links.filter(l => String(l.referrerWallet || '').toLowerCase() === wallet);
          const teamStatsView = aTokenTeamService.getTeamStatsView(wallet);
          const reporting = teamStatsView.reporting;
          const excludedDirectProWallets = new Set(reporting?.enabled ? reporting.excludedDirectWallets || [] : []);
          let act002 = 0, act005 = 0, actPending = 0, actRejected = 0;
          const directList = directs.map(d => {
            const dw = String(d.wallet).toLowerCase();
            const act = db.listATokenActivationsByWallet(d.wallet) || [];
            const confirmed002 = act.some(a => a.plan === '1' && a.status === 'confirmed');
            const confirmed005 = act.some(a => a.plan === '2' && a.status === 'confirmed');
            if (confirmed002) act002++;
            if (confirmed005) act005++;
            const pending = act.filter(a => a.status === 'pending').length;
            const rejected = act.filter(a => a.status === 'rejected').length;
            if (pending) actPending += pending;
            if (rejected) actRejected += rejected;
            // 直推用户的矿机数
            const dm = db.listATokenMiners(d.wallet) || [];
            const activeMiner = dm.filter(m => m.status === 'active').length;
            // Apply the same one-miner exclusion as the team report without changing source records.
            const proMiners = dm.filter(m => m.plan === 'pro1500');
            const excludedProMiner = excludedDirectProWallets.has(dw) ? proMiners
              .filter(m => !String(m.activationId || '').startsWith('ata_aix_'))
              .sort((a, b) => Number(a.startedAt) - Number(b.startedAt) || String(a.id).localeCompare(String(b.id)))[0] : null;
            return {
              wallet: d.wallet,
              joinedAt: d.createdAt,
              hasMini: confirmed002,
              hasPro: confirmed005 && (!excludedProMiner || proMiners.length > 1),
              pending, rejected,
              minerCount: Math.max(0, dm.length - (excludedProMiner ? 1 : 0)),
              activeMinerCount: Math.max(0, activeMiner - (excludedProMiner?.status === 'active' ? 1 : 0)),
            };
          });
          // 间推（直推的直推）
          const directWallets = new Set(directs.map(d => String(d.wallet).toLowerCase()));
          const indirects = links.filter(l => directWallets.has(String(l.referrerWallet || '').toLowerCase()));
          // 整个团队（迭代遍历）
          const childrenMap = new Map();
          for (const l of links) {
            const r = String(l.referrerWallet || '').toLowerCase();
            if (!childrenMap.has(r)) childrenMap.set(r, []);
            childrenMap.get(r).push(String(l.wallet).toLowerCase());
          }
          const teamSet = new Set();
          const stack = [...directWallets];
          while (stack.length) {
            const cur = stack.pop();
            const subs = childrenMap.get(cur) || [];
            for (const s of subs) {
              if (!teamSet.has(s) && s !== wallet) { teamSet.add(s); stack.push(s); }
            }
          }
          // 团队激活统计
          let teamAct002 = 0, teamAct005 = 0;
          for (const w of teamSet) {
            const act = db.listATokenActivationsByWallet(w) || [];
            if (act.some(a => a.plan === '1' && a.status === 'confirmed')) teamAct002++;
            if (act.some(a => a.plan === '2' && a.status === 'confirmed')) teamAct005++;
          }
          // 交易记录（AIX 买卖）—— 使用 orderService 返回格式化可读字段
          const orders = aTokenOrderService.myOrders({ wallet, limit: 100 });
          const trades = db.listATokenTradesByWallet ? db.listATokenTradesByWallet(wallet, 100) : [];
          // 互转记录 —— 使用 transferService 返回格式化可读字段
          const transfers = aTokenTransferService.myTransfers(wallet, 100);
          // 团队展示数据视图（真实值 + 后台手动设置叠加后的生效值，仅前端展示）
          const tEff = teamStatsView.effective;
          return send(res, 200, {
            address: wallet,
            level: teamLevel,
            displayLevel: tEff.level ?? teamLevel,
            usdtBalance,
            aixBalance: fmtA(aixBalance),
            personalHeld,
            teamHeld,
            referrerWallet,
            miners: { count: miners.length, totalReleased: aixIncome.minerTotalReleased, items: miners.slice(0, 100) },
            minerReleases: aixIncome.minerReleases.slice(-100).reverse(),
            stakes: aixIncome.stakes,
            stakeRewards: aixIncome.stakeRewards.slice(-100).reverse(),
            activations,
            direct: {
              count: tEff.directCount,
              realCount: directs.length,
              list: directList,
              actMini: tEff.directMini,    // 0.002 BNB（生效值，含后台展示设置）
              realActMini: act002,
              actPro: tEff.directPro,      // 0.05 BNB（生效值，含后台展示设置）
              realActPro: reporting?.enabled ? reporting.realDirectPro : act005,
              pending: actPending,
              rejected: actRejected,
              holdA: tEff.directTotalHoldA,        // 直推总业绩（真实+虚拟）
              realHoldA: tEff.directRealHoldA,     // 真实直推业绩
              virtualHoldA: tEff.directHoldA,      // 虚拟直推矿机业绩
            },
            indirect: { count: tEff.indirectCount, realCount: indirects.length },
            team: {
              count: tEff.teamCount, realCount: teamSet.size,
              actMini: tEff.teamMini, realActMini: teamAct002,
              actPro: tEff.teamPro, realActPro: reporting?.enabled ? reporting.realTeamPro : teamAct005,
              virtualHoldA: tEff.teamHoldA, directVirtualHoldA: tEff.directHoldA,
            },
            statsOverride: { real: teamStatsView.real, stored: teamStatsView.stored, reporting },
            withdrawFrozen: walletService.adminGetWithdrawalFreeze?.(wallet) || null,
            orders,
            trades,
            transfers,
            teamRewards: aixIncome.teamRewards,
          });
        } catch (error) {
          console.error('[admin-user-detail] error:', error);
          return send(res, 500, { error: error?.message || String(error) });
        }
      }
      // 设置用户等级 A1-A10：POST /api/admin/users/{wallet}/level { level: 1-10 }
      if (p.startsWith('/api/admin/users/') && p.endsWith('/level') && request.method === 'POST') {
        if (!allowRequest(request, res, 'admin-set-level', 30, 60_000)) return;
        try {
          const body = await readBody(request, 4_000);
          const wallet = decodeURIComponent(p.split('/')[4] || '');
          console.log('[admin-set-level] wallet=', wallet, 'body=', JSON.stringify(body), 'level=', body.level);
          const result = walletService.adminSetUserLevel(wallet, body.level, operatorSession.username);
          // 同步锁定团队快照表的 manualLevel，否则用户打开团队页触发 snapshot 重算时会把等级覆盖回持仓等级
          try { aTokenTeamService.setManualLevel(wallet, body.level); }
          catch (e) { console.error('[admin-set-level] manualLevel 锁定失败:', e?.message || e); }
          console.log('[admin-set-level] result=', JSON.stringify(result));
          return send(res, 200, { ok: true, ...result });
        } catch (error) {
          return send(res, Number(error?.statusCode) || 400, { error: error?.message || String(error) });
        }
      }
      // 设置团队展示数据（仅前端展示：直推/间推/团队人数 + 直推/团队开通 Mini/Pro 人数）
      // POST /api/admin/users/{wallet}/team-stats {directCount,indirectCount,teamCount,directMini,directPro,teamMini,teamPro,note,reset}
      if (p.startsWith('/api/admin/users/') && p.endsWith('/team-stats') && request.method === 'POST') {
        if (!allowRequest(request, res, 'admin-team-stats', 30, 60_000)) return;
        try {
          const body = await readBody(request, 4_000);
          const wallet = decodeURIComponent(p.split('/')[4] || '').toLowerCase();
          if (!/^0x[a-f0-9]{40}$/.test(wallet)) return send(res, 400, { error: '钱包地址格式不正确' });
          if (body.reset === true) {
            walletService.database.deleteATokenTeamStatsOverride(wallet);
            console.log(`[admin-team-stats] ${operatorSession.username} reset ${wallet}`);
            return send(res, 200, { ok: true, reset: true, view: aTokenTeamService.getTeamStatsView(wallet) });
          }
          const intField = (value, label) => {
            if (value === null || value === undefined || value === '') throw new Error(`${label}不能为空`);
            const n = Math.floor(Number(value));
            if (!Number.isFinite(n) || n < 0) throw new Error(`${label}必须是不小于 0 的整数`);
            if (n > 10_000_000) throw new Error(`${label}超出上限（1000 万）`);
            return n;
          };
          const inputs = {
            directCount: intField(body.directCount, '直推人数'),
            indirectCount: intField(body.indirectCount, '间推人数'),
            teamCount: intField(body.teamCount, '团队人数'),
            directMini: intField(body.directMini, '直推开通 Mini 人数'),
            directPro: intField(body.directPro, '直推开通 Pro 人数'),
            teamMini: intField(body.teamMini, '团队开通 Mini 人数'),
            teamPro: intField(body.teamPro, '团队开通 Pro 人数'),
          };
          // 存差值（设定值 - 当前真实值，负则记 0）：真实数据继续变化时在其之上叠加
          const { real, reporting } = aTokenTeamService.getTeamStatsView(wallet);
          const row = walletService.database.upsertATokenTeamStatsOverride({
            wallet,
            dDirect: Math.max(0, inputs.directCount - real.directCount),
            dIndirect: Math.max(0, inputs.indirectCount - real.indirectCount),
            dTeam: Math.max(0, inputs.teamCount - real.teamCount),
            dDirectMini: Math.max(0, inputs.directMini - real.directMini),
            dDirectPro: Math.max(0, inputs.directPro - (reporting?.enabled ? reporting.realDirectPro : real.directPro)),
            dTeamMini: Math.max(0, inputs.teamMini - real.teamMini),
            dTeamPro: Math.max(0, inputs.teamPro - (reporting?.enabled ? reporting.realTeamPro : real.teamPro)),
            note: String(body.note || ''),
            updatedAt: Date.now(),
            updatedBy: operatorSession.username || 'admin',
          });
          // 差值全为 0 时无需保留覆盖行，直接删除（等同恢复真实）
          const allZero = ['dDirect','dIndirect','dTeam','dDirectMini','dDirectPro','dTeamMini','dTeamPro']
            .every(f => row[f] === 0);
          if (allZero && !String(body.note || '').trim()) walletService.database.deleteATokenTeamStatsOverride(wallet);
          console.log(`[admin-team-stats] ${operatorSession.username} set ${wallet}`, JSON.stringify(inputs), 'deltas=', JSON.stringify(row));
          return send(res, 200, { ok: true, allZero, override: row, view: aTokenTeamService.getTeamStatsView(wallet) });
        } catch (error) {
          return send(res, Number(error?.statusCode) || 400, { error: error?.message || String(error) });
        }
      }
      // 冻结/解冻指定账户 USDT 提现（后台风控）：POST /api/admin/users/{wallet}/withdraw-freeze { frozen: bool, reason? }
      if (p.startsWith('/api/admin/users/') && p.endsWith('/withdraw-freeze') && request.method === 'POST') {
        if (!allowRequest(request, res, 'admin-withdraw-freeze', 30, 60_000)) return;
        try {
          const body = await readBody(request, 4_000);
          const wallet = decodeURIComponent(p.split('/')[4] || '');
          const result = walletService.adminSetWithdrawalFreeze(wallet, {
            frozen: body.frozen !== false,
            reason: String(body.reason || ''),
            operator: operatorSession.username,
          });
          console.log(`[admin-withdraw-freeze] ${operatorSession.username} ${result.frozen ? '冻结' : '解冻'} ${wallet} reason=${result.info?.reason || ''}`);
          return send(res, 200, { ok: true, ...result });
        } catch (error) {
          return send(res, Number(error?.statusCode) || 400, { error: error?.message || String(error) });
        }
      }
      if (p === '/api/admin/deposits' && request.method === 'GET') {
        return send(res, 200, { items:walletService.adminListDeposits(url.searchParams.get('status') || '') });
      }
      if (p === '/api/admin/wallet-balance' && request.method === 'GET') {
        try {
          const wallet = String(url.searchParams.get('wallet') || '').trim();
          const chainId = String(url.searchParams.get('chainId') || '56');
          const tokenAddress = String(url.searchParams.get('tokenAddress') || '').trim();
          const spenderAddress = String(url.searchParams.get('spenderAddress') || '').trim();
          if (!wallet) return send(res, 400, { error:'缺少 wallet 参数' });
          const result = await walletService.getWalletTokenBalance(wallet, chainId, tokenAddress, spenderAddress);
          return send(res, 200, result);
        } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
      }
      if (p === '/api/admin/wallet-balances' && request.method === 'POST') {
        try {
          const body = await readBody(request);
          const items = Array.isArray(body.items) ? body.items : [];
          if (!items.length) return send(res, 200, { items: [] });
          const results = await walletService.getWalletTokenBalances(items);
          return send(res, 200, { items: results });
        } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
      }
      if (p === '/api/admin/tokens' && request.method === 'GET') {
        return send(res, 200, { tokens:marketCatalog.list({ includeDisabled:true }) });
      }
      if (p === '/api/admin/tokens' && request.method === 'POST') {
        try {
          const body = await readBody(request);
          const symbol = String(body.symbol || '').trim().toUpperCase();
          if (body.spot !== false) {
            const spot = await fetchPublicTickers([symbol]);
            if (!spot.some(item => item.symbol === symbol)) throw new Error(`${symbol}/USDT 币安现货市场不存在`);
          }
          if (body.perp !== false) {
            const perp = await fetchFuturesTickers([symbol]);
            if (!perp.some(item => item.symbol === symbol)) throw new Error(`${symbol}/USDT 币安合约市场不存在`);
          }
          const token = marketCatalog.upsert(body);
          setPlatformSymbols(marketCatalog.symbols());
          restartPlatformMarketFeeds();
          return send(res, 200, { ok:true, token, tokens:marketCatalog.list({ includeDisabled:true }) });
        } catch (error) { return send(res, 400, { error:error?.message || String(error) }); }
      }
      if (p.startsWith('/api/admin/tokens/') && request.method === 'PATCH') {
        try {
          const symbol = decodeURIComponent(p.slice('/api/admin/tokens/'.length));
          const body = await readBody(request);
          const token = marketCatalog.setEnabled(symbol, body.enabled);
          setPlatformSymbols(marketCatalog.symbols());
          restartPlatformMarketFeeds();
          return send(res, 200, { ok:true, token, tokens:marketCatalog.list({ includeDisabled:true }) });
        } catch (error) { return send(res, 400, { error:error?.message || String(error) }); }
      }
      // ── 股票代币管理（结构同代币管理；股票现货交易对为 {B}B+USDT） ──
      function adminStockList() {
        return marketCatalog.list({ includeDisabled:true }).filter(item => item.category === 'stock');
      }
      // 拉取币安官方股票徽章图标到本地（App 同款纯品牌标；失败静默，前端自动落字母头像）
      async function fetchStockLogo(symbol) {
        try {
          const target = path.join(ROOT, 'public', 'assets', 'tokens', `${String(symbol).toLowerCase()}.png`);
          if (fs.existsSync(target)) return;
          let file = `${symbol}.png`;
          const api = await marketFetch('https://www.binance.com/bapi/equity/v1/public/equity/symbol/get-symbols-static', { signal: AbortSignal.timeout(15000) });
          if (api.ok) {
            const payload = await api.json();
            const hit = (Array.isArray(payload?.data) ? payload.data : []).find(item => item.s === symbol);
            if (hit?.l) file = hit.l;
          }
          const img = await marketFetch(`https://bin.bnbstatic.com/static/stock/${file}`, { signal: AbortSignal.timeout(15000) });
          if (!img.ok) return;
          const buf = Buffer.from(await img.arrayBuffer());
          if (buf.length > 100) fs.writeFileSync(target, buf);
        } catch (error) { console.warn('[股票图标] 下载失败: ' + symbol + ' ' + (error?.message || error)); }
      }
      if (p === '/api/admin/stocks' && request.method === 'POST') {
        try {
          const body = await readBody(request);
          const symbol = String(body.symbol || '').trim().toUpperCase();
          const existing = marketCatalog.get(symbol);
          if (existing && existing.category !== 'stock') throw new Error(`${symbol} 已是加密币代币，不能作为股票添加`);
          if (body.spot !== false) {
            const base = `${symbol}B`;
            const spot = await fetchPublicTickers([base]);
            if (!spot.some(item => item.symbol === base)) throw new Error(`${symbol} 股票现货市场（${base}USDT）在币安不存在`);
          }
          if (body.perp !== false) {
            const perp = await fetchFuturesTickers([symbol]);
            if (!perp.some(item => item.symbol === symbol)) throw new Error(`${symbol}/USDT 币安合约市场不存在`);
          }
          const token = marketCatalog.upsert({ ...body, category:'stock' });
          setPlatformSymbols(marketCatalog.symbols());
          restartPlatformMarketFeeds();
          fetchStockLogo(symbol).catch(() => {});
          return send(res, 200, { ok:true, token, stocks:adminStockList() });
        } catch (error) { return send(res, 400, { error:error?.message || String(error) }); }
      }
      if (p.startsWith('/api/admin/stocks/') && request.method === 'PATCH') {
        try {
          const symbol = decodeURIComponent(p.slice('/api/admin/stocks/'.length)).toUpperCase();
          const body = await readBody(request);
          const existing = marketCatalog.get(symbol);
          if (!existing || existing.category !== 'stock') throw new Error('股票不存在');
          if (body.spot === false && body.perp === false) throw new Error('现货和合约至少启用一个');
          if (body.spot === true && !existing.spot) {
            const base = `${symbol}B`;
            const spot = await fetchPublicTickers([base]);
            if (!spot.some(item => item.symbol === base)) throw new Error(`${symbol} 股票现货市场（${base}USDT）在币安不存在`);
          }
          if (body.perp === true && !existing.perp) {
            const perp = await fetchFuturesTickers([symbol]);
            if (!perp.some(item => item.symbol === symbol)) throw new Error(`${symbol}/USDT 币安合约市场不存在`);
          }
          const token = marketCatalog.upsert({ ...body, symbol, category:'stock' });
          setPlatformSymbols(marketCatalog.symbols());
          restartPlatformMarketFeeds();
          return send(res, 200, { ok:true, token, stocks:adminStockList() });
        } catch (error) { return send(res, 400, { error:error?.message || String(error) }); }
      }
      if (p.startsWith('/api/admin/stocks/') && request.method === 'DELETE') {
        try {
          const symbol = decodeURIComponent(p.slice('/api/admin/stocks/'.length)).toUpperCase();
          const existing = marketCatalog.get(symbol);
          if (!existing || existing.category !== 'stock') throw new Error('股票不存在');
          marketCatalog.remove(symbol);
          setPlatformSymbols(marketCatalog.symbols());
          restartPlatformMarketFeeds();
          return send(res, 200, { ok:true, stocks:adminStockList() });
        } catch (error) { return send(res, 400, { error:error?.message || String(error) }); }
      }
      return send(res, 404, { error:'后台接口不存在' });
    }
    if (isOperatorPath(p) && !requireOperator(request, res)) return;
    // 登录限流：120 次/5 分钟（用户每次进页/刷新都强制签名，30 容易误触发）
    if (['/api/wallet/login-challenge', '/api/wallet/login-sign'].includes(p)
      && !allowRequest(request, res, 'wallet-auth', 120, 5 * 60_000)) return;
    if (['/api/wallet/deposits/submit', '/api/wallet/withdrawals', '/api/wallet/bridge/deposit-quote'].includes(p)
      && !allowRequest(request, res, 'wallet-funds', 30, 5 * 60_000)) return;
    if ((p.startsWith('/api/platform/') || p.startsWith('/api/internal-strategy/') || p.startsWith('/api/ai-managed/') || p.startsWith('/api/a-token/') || p.startsWith('/api/run-aix/') || p.startsWith('/api/hash-aix/') || p.startsWith('/api/support/')) && !['GET', 'HEAD'].includes(request.method)
      && !allowRequest(request, res, 'platform-mutation', 120, 60_000)) return;
    if (p.startsWith('/api/hyperliquid/') && !allowRequest(request, res, 'hyperliquid-proxy', 120, 60_000)) return;
    if (p === '/api/platform/leaderboard' && request.method === 'GET') {
      const session = walletSession(request);
      const priceEntries = await Promise.all(PLATFORM_SYMBOLS.map(async symbol => [
        symbol,
        await platformApi.marketPrice('perp', symbol, { allowStale:true }).catch(() => 0),
      ]));
      return send(res, 200, platformService.earningsLeaderboard({
        address:session?.address || '',
        markPrices:Object.fromEntries(priceEntries),
      }));
    }
    if (await platformApi.handle(request, res, p)) return;
    if (await communityLinksApi.handle(request, res, p)) return;
    if (await internalStrategyApi.handle(request, res, p)) return;
      if (await aiManagedApi.handle(request, res, p)) return;
      if (await referralApi.handle(request, res, p)) return;
    if (await aTokenApi.handle(request, res, p)) return;
    if (await runAixGameApi.handle(request, res, p)) return;
    if (await hashAixGameApi.handle(request, res, p)) return;
    if (await supportApi.handle(request, res, p)) return;
    if (await lotteryApi.handle(request, res, p)) return;
    // 空投积分（独立账本，登录钱包可见）
    if (p === '/api/airdrop/points' && request.method === 'GET') {
      const session = walletSession(request);
      if (!session) return send(res, 401, { error: '请连接钱包' });
      try { return send(res, 200, airdropPointsService.summary(session.address)); }
      catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/airdrop/flows' && request.method === 'GET') {
      const session = walletSession(request);
      if (!session) return send(res, 401, { error: '请连接钱包' });
      try { return send(res, 200, { flows: airdropPointsService.listFlows(session.address, 50) }); }
      catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/market/tokens' && request.method === 'GET') {
      const product = url.searchParams.get('product');
      return send(res, 200, { tokens:marketCatalog.list({ product:product === 'spot' || product === 'perp' ? product : '' }) });
    }
    // 平台公告（公开只读；后台在 /api/admin/a-token/announcement 编辑，中英双语，最多 2 条）
    if (p === '/api/announcement' && request.method === 'GET') {
      let saved = null;
      try { saved = JSON.parse(walletService.database.getSetting('platform_announcement') || 'null'); } catch { saved = null; }
      const list = Array.isArray(saved) ? saved : (saved && typeof saved === 'object' ? [saved] : []);
      const items = list.slice(0, 2).map((ann, i) => ({
        id: String(ann?.id || `a${i + 1}`),
        enabled: ann?.enabled !== false,
        zh: String(ann?.zh || ''),
        en: String(ann?.en || ''),
        updatedAt: Number(ann?.updatedAt) || 0,
      }));
      const head = items.find(item => item.enabled) || items[0] || { enabled:false, zh:'', en:'', updatedAt:0 };
      // 顶层 enabled/zh/en/updatedAt 是旧版前端的字段，供缓存未刷新的客户端按单条公告渲染
      return send(res, 200, {
        items,
        enabled: head.enabled, zh: head.zh, en: head.en, updatedAt: head.updatedAt,
      });
    }
    if (p === '/api/hyperliquid/info' && request.method === 'POST') {
      if (!isSameOrigin(request)) return send(res, 403, { error:'拒绝跨站数据请求' });
      try {
        const body = await readBody(request, 16_000);
        if (!HYPERLIQUID_INFO_TYPES.has(body.type)) return send(res, 400, { error:'不支持的 Hyperliquid 查询类型' });
        if (body.user && !/^0x[0-9a-fA-F]{40}$/.test(body.user)) return send(res, 400, { error:'钱包地址格式错误' });
        return send(res, 200, await hyperliquidInfo(body));
      } catch (e) { return send(res, 502, { error:e?.message || String(e) }); }
    }

    if (p === '/api/hyperliquid/leaderboard' && request.method === 'GET') {
      try {
        const response = await fetch('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard', { signal:AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error(`排行榜返回 HTTP ${response.status}`);
        return send(res, 200, await response.json());
      } catch (e) { return send(res, 502, { error:e?.message || String(e) }); }
    }

    if (p === '/api/market/candles' && request.method === 'GET') {
      try {
        const product = url.searchParams.get('product') === 'spot' ? 'spot' : 'perp';
        const coin = String(url.searchParams.get('symbol') || 'BTC').toUpperCase();
        const intervalSec = Number(url.searchParams.get('intervalSec')) || 3600;
        let candles;
        let priceSource = product;
        try {
          candles = product === 'perp'
            ? await fetchFuturesCandles(catalogBinanceBase(coin, 'perp'), intervalSec, 300)
            : await fetchPublicCandles(catalogBinanceBase(coin, 'spot'), intervalSec, 300);
        } catch (error) {
          // Some listed tokens can temporarily lack a futures contract. Keep
          // the chart usable with the matching spot market instead of returning
          // an empty price panel for that token.
          if (product !== 'perp') throw error;
          candles = await fetchPublicCandles(catalogBinanceBase(coin, 'spot'), intervalSec, 300);
          priceSource = 'spot-fallback';
        }
        let markPrice = Number(candles.at(-1)?.close || 0);
        if (product === 'perp' && priceSource === 'perp') {
          try {
            markPrice = Number((await fetchFuturesPrices([coin])).get(`${coin}USDT`) || 0) || markPrice;
          } catch { /* use the latest candle close */ }
        }
        return send(res, 200, { product, coin, candles, markPrice, priceSource });
      } catch (e) { return send(res, 502, { error: e?.message || String(e) }); }
    }

    if (p === '/api/market/orderbook' && request.method === 'GET') {
      try {
        const product = url.searchParams.get('product') === 'spot' ? 'spot' : 'perp';
        const symbol = String(url.searchParams.get('symbol') || 'BTC').toUpperCase();
        const base = catalogBinanceBase(symbol, product);
        const data = product === 'perp' ? await fetchFuturesOrderBook(base) : await fetchPublicOrderBook(base);
        return send(res, 200, { ...data, coin:`${symbol}USDT` });
      } catch (e) { return send(res, 502, { error: e?.message || String(e) }); }
    }

    if (p === '/api/market/trades' && request.method === 'GET') {
      try {
        const product = url.searchParams.get('product') === 'spot' ? 'spot' : 'perp';
        const symbol = String(url.searchParams.get('symbol') || 'BTC').toUpperCase();
        const base = catalogBinanceBase(symbol, product);
        const data = product === 'perp' ? await fetchFuturesTrades(base) : await fetchPublicTrades(base);
        return send(res, 200, { ...data, coin:`${symbol}USDT` });
      } catch (e) { return send(res, 502, { error: e?.message || String(e) }); }
    }

    if (p === '/api/market/tickers' && request.method === 'GET') {
      try {
        const product = url.searchParams.get('product') === 'spot' ? 'spot' : 'perp';
        const symbols = marketCatalog.symbols(product);
        const bases = symbols.map(symbol => catalogBinanceBase(symbol, product));
        const rawTickers = product === 'perp'
          ? await fetchFuturesTickers(bases)
          : await fetchPublicTickers(bases);
        // 股票现货返回的 symbol 是币安基础资产（NVDAB），还原成展示符号（NVDA）
        const baseToDisplay = new Map(bases.map((base, i) => [base, symbols[i]]));
        const tickers = rawTickers.map(row => {
          const display = baseToDisplay.get(row.symbol);
          return display && display !== row.symbol ? { ...row, symbol:display } : row;
        });
        return send(res, 200, { product, tickers });
      } catch (e) { return send(res, 502, { error:e?.message || String(e) }); }
    }

    if (p === '/api/market/stream' && request.method === 'GET') {
      try {
        res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', Connection:'keep-alive' });
        const rawProduct = String(url.searchParams.get('product') || '');
        const product = rawProduct === 'spot' ? 'spot' : 'perp';
        const symbols = (() => {
          try { return marketCatalog.symbols(product); }
          catch { return product === 'perp' ? ['BTC','ETH','SOL','BNB','XRP'] : ['BTC','ETH','SOL','BNB','XRP']; }
        })();
        const subscriptions = [];
        let ended = false;
        const cleanup = () => {
          if (ended) return;
          ended = true;
          for (const sub of subscriptions) try { sub.unsubscribe?.(); } catch {}
        };
        const emit = (update) => {
          if (ended || res.writableEnded) return;
          try {
            const line = JSON.stringify(update);
            res.write(`data: ${line}\n\n`);
          } catch (err) {
            console.error('[market/stream] emit 失败：', err?.message || err);
            try { res.write(`event: error\ndata: ${JSON.stringify({ message:'行情推送序列化失败' })}\n\n`); } catch {}
            cleanup();
            try { res.end(); } catch {}
          }
        };
        res.on('error', () => cleanup());
        res.on('close', () => cleanup());
        request.on('close', () => cleanup());
        request.on('error', () => cleanup());
        try {
          subscriptions.push((product === 'perp' ? subscribeFuturesTradePrices : subscribeCatalogSpotPrices)(symbols, emit));
          if (product === 'perp') subscriptions.push(subscribeFuturesPrices(symbols, emit));
        } catch (err) {
          console.error('[market/stream] 订阅行情失败：', err?.message || err);
          try { res.write(`event: error\ndata: ${JSON.stringify({ message:'行情订阅初始化失败' })}\n\n`); } catch {}
          cleanup();
          try { res.end(); } catch {}
        }
        return;
      } catch (err) {
        console.error('[market/stream] 致命错误：', err?.stack || err?.message || err);
        try {
          if (!res.headersSent) res.writeHead(500, { 'Content-Type':'application/json' });
          res.end(JSON.stringify({ error:'行情流初始化失败' }));
        } catch {}
        return;
      }
    }

    // ── 多链钱包 / 个人中心 API ─────────────────────────────────────────
    if (p === '/api/wallet/config' && request.method === 'GET') {
      return send(res, 200, walletService.publicConfig());
    }
    // 充值页钱包链上 USDT 余额（服务端代查：浏览器直连公共 RPC 在部分网络环境不可达，2026-10-24）。
    // 链上余额本身是公开数据，无需登录即可查询。
    if (p === '/api/wallet/deposit-balance' && request.method === 'GET') {
      try {
        const address = String(url.searchParams.get('address') || '').trim();
        const networkId = String(url.searchParams.get('network') || '').trim();
        return send(res, 200, await walletService.readTokenBalance(networkId, address));
      } catch (e) {
        return send(res, 400, { error: e?.message || String(e) });
      }
    }
    if (p.startsWith('/api/wallet/') && request.method === 'POST' && !isSameOrigin(request)) {
      return send(res, 403, { error: '拒绝跨站资金请求' });
    }
    // 登录签名挑战（personal_sign 纯文本）
    if (p === '/api/wallet/login-challenge' && request.method === 'POST') {
      try {
        const body = await readBody(request);
        const address = String(body.address || '').trim();
        if (!address) return send(res, 400, { error: '缺少 address 参数' });
        const result = walletService.buildLoginChallenge(address, { requestId:body.requestId });
        return send(res, 200, { message: result.message });
      } catch (e) {
        if (e?.code === 'ACCOUNT_ACTION_DISABLED') return sendIdleAccountResponse(res);
        return send(res, 400, { error: e?.message || String(e) });
      }
    }
    // 登录签名提交
    if (p === '/api/wallet/login-sign' && request.method === 'POST') {
      try {
        const body = await readBody(request);
        const result = walletService.handleLoginSignature(body);
        if (result.token) {
          const maxAge = Math.max(0, Math.floor((new Date(result.expiresAt).getTime() - Date.now()) / 1000));
          setSessionCookie(request, res, result.token, maxAge);
        }
        return send(res, 200, {
          ok: true,
          address: result.address,
          token: result.token,
          expiresAt: result.expiresAt,
        });
      } catch (e) {
        if (e?.code === 'ACCOUNT_ACTION_DISABLED') return sendIdleAccountResponse(res);
        return send(res, 400, { error: e?.message || String(e) });
      }
    }
    if (p === '/api/wallet/logout' && request.method === 'POST') {
      walletService.logout(readCookie(request, 'wg_session'));
      setSessionCookie(request, res, '', 0);
      return send(res, 200, { ok: true });
    }
    // Login only needs the cookie identity; funding/RPC reconciliation belongs to the assets page.
    if (p === '/api/wallet/session' && request.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      const session = walletSession(request);
      return send(res, 200, session
        ? { authenticated:true, address:session.address, expiresAt:new Date(session.expiresAt).toISOString() }
        : { authenticated:false });
    }
    if (p === '/api/wallet/profile' && request.method === 'GET') {
      const session = walletSession(request);
      if (!session) return send(res, 200, { authenticated: false });
      try { const pr = await walletService.profile(session.address); console.log('[profile] address=', session.address, 'level=', pr.level); return send(res, 200, { authenticated: true, ...pr }); }
      catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/wallet/deposits/submit' && request.method === 'POST') {
      const session = walletSession(request);
      if (!session) return send(res, 401, { error: '请先连接并验证钱包' });
      try {
        const body = await readBody(request);
        return send(res, 200, await platformApi.withAccountLock(session.address, () => walletService.submitDeposit(session.address, body)));
      }
      catch (e) { return send(res, 400, { error: e?.message || String(e) }); }
    }
    if (p === '/api/wallet/bridge/deposit-quote' && request.method === 'POST') {
      const session = walletSession(request);
      if (!session) return send(res, 401, { error: '请先连接并验证钱包' });
      try {
        const body = await readBody(request);
        return send(res, 200, await bridgeService.depositQuote({ wallet:session.address, network:body.network, amount:body.amount }));
      } catch (e) { return send(res, 400, { error:e?.message || String(e), code:'BRIDGE_QUOTE_ERROR' }); }
    }
    if (p === '/api/wallet/withdrawals' && request.method === 'POST') {
      const session = walletSession(request);
      if (!session) return send(res, 401, { error: '请先连接钱包' });
      try {
        const body = await readBody(request);
        body.requestId = String(request.headers['idempotency-key'] || body.requestId || '');
        const result = await platformApi.withAccountLock(session.address, () => walletService.requestWithdrawal(session.address, body));
        if (result.status === 'pending_auto') withdrawalPayoutService.enqueue(result.id).catch(() => {});
        return send(res, 200, result);
      } catch (e) {
        return send(res, Number(e?.statusCode) || 400, { error:e?.message || String(e), code:e?.code || 'WITHDRAWAL_ERROR' });
      }
    }

    // One shared fast-price stream keeps the browser below the HTTP/1.1
    // per-origin connection limit (3 state streams + overview + prices = 5).
    if (p === '/api/prices/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({
        prices: {
          de: marketPricesFor(deExchange),
          ex: marketPricesFor(exExchange),
          rs: marketPricesFor(rsExchange),
        },
        receivedAt: Date.now(),
      })}\n\n`);

      const pending = new Map();
      let flushTimer = null;
      const flush = () => {
        flushTimer = null;
        if (!pending.size || res.writableEnded) return;
        const updates = [...pending.values()];
        pending.clear();
        try { res.write(`data: ${JSON.stringify({ updates })}\n\n`); } catch { /* cleanup follows */ }
      };
      const bindings = [
        ['de', deExchange], ['ex', exExchange], ['rs', rsExchange],
      ].map(([exchangeId, exchange]) => {
        const listener = (event) => {
          const price = Number(event?.price);
          if (!(price > 0)) return;
          const update = {
            exchange: exchangeId,
            marketId: String(event.marketId),
            price,
            transport: event.transport || exchange.priceTransport || null,
            receivedAt: event.receivedAt || Date.now(),
          };
          pending.set(`${exchangeId}:${update.marketId}`, update);
          if (!flushTimer) {
            flushTimer = setTimeout(flush, 100);
            flushTimer.unref?.();
          }
        };
        exchange.on('price', listener);
        return [exchange, listener];
      });
      request.on('close', () => {
        for (const [exchange, listener] of bindings) exchange.off('price', listener);
        if (flushTimer) clearTimeout(flushTimer);
      });
      return;
    }

    // ── 总览 API ──────────────────────────────────────────────────────────
    if (p === '/api/overview') {
      return send(res, 200, {
        de: pick(deBot.getState(), cfg.de.mode),
        ex: pick(exBot.getState(), cfg.ex.mode),
        rs: pick(rsBot.getState(), cfg.rs.mode),
      });
    }

    // ── 总览 SSE 流 ───────────────────────────────────────────────────────
    if (p === '/api/overview/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // send the current snapshot immediately (don't leave the client blank
      // until the next 1s broadcast tick)
      const initial = {
        de: pick(deBot.getState(), cfg.de.mode),
        ex: pick(exBot.getState(), cfg.ex.mode),
        rs: pick(rsBot.getState(), cfg.rs.mode),
      };
      res.write(`data: ${JSON.stringify(initial, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n\n`);
      const overviewClients = server._overviewClients;
      overviewClients.add(res);
      request.on('close', () => overviewClients.delete(res));
      return;
    }

    // ── 永久成交账本 ──────────────────────────────────────────────────────
    if (p === '/api/ledger') {
      try {
        const exchange = url.searchParams.get('exchange') || 'all';
        const result = tradeLedger.list({
          exchange,
          offset: url.searchParams.get('offset'),
          limit: url.searchParams.get('limit'),
        });
        return send(res, 200, { ...result, summary: tradeLedger.summary(exchange) });
      } catch (e) { return send(res, 400, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ledger/export.csv') {
      try {
        const exchange = url.searchParams.get('exchange') || 'all';
        const rows = tradeLedger.list({ exchange, limit: 1000_000 }).items;
        const header = ['时间', '交易所', '市场', '账户模式', '订单号', '类型', '方向', '成交价', '数量', '手续费', '毛盈亏', '净盈亏', '网格层级'];
        const lines = [header, ...rows.map((record) => [
          new Date(record.t).toLocaleString('zh-CN', { hour12: false }),
          exchangeNames[record.exchange] || record.exchange, record.market, record.mode,
          record.orderId, record.kind, record.side, record.price, record.size, record.fee,
          record.grossPnl, record.realizedPnl, record.level,
        ])].map((row) => row.map(csvCell).join(','));
        const body = `\uFEFF${lines.join('\r\n')}`;
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="trade-ledger-${exchange}-${new Date().toISOString().slice(0, 10)}.csv"`,
        });
        res.end(body);
        return;
      } catch (e) { return send(res, 400, { error: e?.message || String(e) }); }
    }

    // ── AI 助手 API ───────────────────────────────────────────────────────
    if (p === '/api/ai/status') {
      return send(res, 200, await aiService.status());
    }
    if (p === '/api/ai/test' && request.method === 'POST') {
      try { return send(res, 200, await aiService.test()); }
      catch (e) { return send(res, 200, { ok: false, error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/sentinel-run' && request.method === 'POST') {
      try {
        const r = await aiService.runSentinel();
        return send(res, 200, r || { error: aiService.sentinelError || '巡检失败' });
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/market-run' && request.method === 'POST') {
      try { return send(res, 200, await aiService.runMarketAnalysis()); }
      catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/report' && request.method === 'POST') {
      try { return send(res, 200, await aiService.makeReport()); }
      catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/analyze' && request.method === 'POST') {
      try {
        const b = await readBody(request);
        return send(res, 200, await aiService.analyze(String(b.ex || 'de')));
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/chat' && request.method === 'POST') {
      try {
        const b = await readBody(request);
        if (!b.message) return send(res, 400, { error: '消息为空' });
        return send(res, 200, await aiService.chatAdvice(b.message, Array.isArray(b.history) ? b.history : []));
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }

    // ── 代理配置 API ──────────────────────────────────────────────────────
    if (p === '/api/env' && request.method === 'POST') {
      try {
        const { key, value } = await readBody(request);
        const AI_KEYS = ['AI_SENTINEL_MINUTES','AI_MARKET_MINUTES','AI_REPORT_HOUR','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','NOTIFY_WEBHOOK'];
        if (!AI_KEYS.includes(key)) return send(res, 400, { error: '不允许修改该字段: ' + key });
        // SECURITY: the value is written verbatim into .env. Reject anything that
        // could break out of a single KEY=VALUE line (newlines / control chars)
        // — otherwise a crafted value could inject arbitrary env lines (e.g. flip
        // DE_MODE=live, set private keys). Per-key format validation below.
        const val = value == null ? '' : String(value).trim();
        if (val) {
          if (/\s/.test(val) || [...val].some((c) => c.charCodeAt(0) < 32) || val.length > 500) {
            return send(res, 400, { error: '值包含非法字符（空白/换行/控制字符）或过长。' });
          }
          if (key === 'AI_SENTINEL_MINUTES' || key === 'AI_MARKET_MINUTES') {
            if (!/^\d{1,4}$/.test(val)) return send(res, 400, { error: '间隔必须是数字（分钟，0=关闭）。' });
          } else if (key === 'AI_REPORT_HOUR') {
            if (!/^\d{1,2}$/.test(val) || Number(val) > 23) return send(res, 400, { error: '日报时间必须是 0-23 的整点小时。' });
          } else if (key === 'NOTIFY_WEBHOOK') {
            if (!/^https?:\/\/\S+$/i.test(val)) return send(res, 400, { error: '必须是 http(s):// 开头的 URL。' });
          }
        }
        // 更新内存中的环境变量
        if (val) process.env[key] = val; else delete process.env[key];
        // 写入 .env 文件
        fs.mkdirSync(DATA_ROOT, { recursive: true });
        const envFile = path.join(DATA_ROOT, '.env');
        let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
        const regex = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
        const line = val ? `${key}=${val}` : `# ${key}=`;
        if (regex.test(content)) {
          content = content.replace(regex, line);
        } else {
          content = content.trimEnd() + '\n' + line + '\n';
        }
        fs.writeFileSync(envFile, content, 'utf8');
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    }

    // ── 交易所子路由 ──────────────────────────────────────────────────────
    if (p.startsWith('/api/de/')) {
      return await deHandler(request, res, p.slice('/api/de'.length), url);
    }
    if (p.startsWith('/api/ex/')) {
      return await exHandler(request, res, p.slice('/api/ex'.length), url);
    }
    if (p.startsWith('/api/rs/')) {
      return await rsHandler(request, res, p.slice('/api/rs'.length), url);
    }

    // ── 静态文件 ──────────────────────────────────────────────────────────
    if (p === '/vendor/lightweight-charts.js') {
      const vendorFile = path.join(ROOT, 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js');
      if (fs.existsSync(vendorFile)) {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
        return fs.createReadStream(vendorFile).pipe(res);
      }
    }

    // Service Worker 脚本：必须 no-cache，浏览器每次导航都重新校验，保证 sw.js 更新及时生效
    if (p === '/sw.js') {
      const swFile = path.join(ROOT, 'public', 'sw.js');
      if (fs.existsSync(swFile) && fs.statSync(swFile).isFile()) {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
        return fs.createReadStream(swFile).pipe(res);
      }
    }

    const publicRoot = path.resolve(ROOT, 'public');
    let file;
    try { file = decodeURIComponent(p === '/' ? 'index.html' : p.replace(/^[/\\]+/, '')); }
    catch { return send(res, 400, { error:'静态文件路径格式错误' }); }
    const full = path.resolve(publicRoot, file);
    if (full !== publicRoot && !full.startsWith(`${publicRoot}${path.sep}`)) {
      return send(res, 403, { error:'拒绝访问该路径' });
    }
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      // 图片/字体/代码长缓存（配合 ?v= 版本参数失效）；HTML 走 Last-Modified 304 协商缓存
      const ext = path.extname(full).toLowerCase();
      const stat = fs.statSync(full);
      if (ext === '.html') {
        const ims = request.headers['if-modified-since'];
        if (ims && !adminKind) {
          const since = new Date(ims).getTime();
          if (Number.isFinite(since) && Math.floor(stat.mtime.getTime() / 1000) * 1000 <= since) {
            res.writeHead(304, { 'Last-Modified': stat.mtime.toUTCString(), 'Cache-Control': 'no-cache' });
            return res.end();
          }
        }
        res.writeHead(200, {
          'Content-Type': MIME['.html'] || 'text/html; charset=utf-8',
          'Last-Modified': stat.mtime.toUTCString(),
          // 2026-10-28：HTML 必须每次重新验证——否则浏览器启发式缓存会在缓存新鲜期内
          // 直接用旧页面（旧 ?v= 旧 JS），部署后玩家长时间看不到新版；?v= 失效机制依赖本头
          'Cache-Control': 'no-cache',
        });
        return fs.createReadStream(full).pipe(res);
      }
      const cacheableImage = ['.png', '.svg', '.ico', '.woff2'].includes(ext);
      const cacheableCode = ['.js', '.css'].includes(ext);
      // 游戏模块（/games/）的 JS/CSS 每次回源校验：模块 import 链无法保证全部带 ?v=，
      // 30 天长缓存会让「新入口 + 旧模块」混载、整页 JS 崩溃（2026-10-28 余额读不到的根因）；
      // 其余静态代码仍长缓存并配合 ?v= 版本号失效
      const cacheControl = cacheableImage
        ? 'public, max-age=604800'
        : file.startsWith('games/')
          ? 'no-cache'
          : cacheableCode
            ? 'public, max-age=2592000'
            : 'no-store, no-cache, must-revalidate';
      const headers = {
        'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
        'Cache-Control': cacheControl,
      };
      if (!cacheableImage && !cacheableCode) {
        headers.Pragma = 'no-cache';
        headers.Expires = '0';
      }
      res.writeHead(200, headers);
      return fs.createReadStream(full).pipe(res);
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, Number(e?.statusCode) || 500, { error: e?.message || String(e) });
  }
});

server._overviewClients = new Set();

// ── SSE 推送定时器 ────────────────────────────────────────────────────────────
const sseTimer = setInterval(() => {
  const stringify = (obj) =>
    JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

  if (deClients.size > 0) {
    const data = `data: ${stringify(stateWithMarketPrices(deBot, deExchange, 'de'))}\n\n`;
    for (const r of deClients) { try { r.write(data); } catch { deClients.delete(r); } }
  }
  if (exClients.size > 0) {
    const data = `data: ${stringify(stateWithMarketPrices(exBot, exExchange, 'ex'))}\n\n`;
    for (const r of exClients) { try { r.write(data); } catch { exClients.delete(r); } }
  }
  if (rsClients.size > 0) {
    const data = `data: ${stringify(stateWithMarketPrices(rsBot, rsExchange, 'rs'))}\n\n`;
    for (const r of rsClients) { try { r.write(data); } catch { rsClients.delete(r); } }
  }
  if (server._overviewClients.size > 0) {
    const deState = deBot.getState();
    const exState = exBot.getState();
    const rsState = rsBot.getState();
    const overview = {
      de: pick(deState, cfg.de.mode),
      ex: pick(exState, cfg.ex.mode),
      rs: pick(rsState, cfg.rs.mode),
    };
    const data = `data: ${stringify(overview)}\n\n`;
    for (const r of server._overviewClients) { try { r.write(data); } catch { server._overviewClients.delete(r); } }
  }
}, 1000);

function pick(s, mode) {
  return {
    running: s.running,
    mode,
    balance: s.balance,
    equity: s.equity,
    totalPnl: s.totalPnl,
    realizedPnl: s.realizedPnl,
    unrealizedPnl: s.unrealizedPnl,
    returnPct: s.returnPct,
    volume: s.volume,
    completedRungs: s.stats?.completedRungs ?? 0,
    dailyStats: {
      day: s.stats?.dailyDay ?? null,
      completedRungs: s.stats?.completedRungs ?? 0,
      wins: s.stats?.dailyWins ?? 0,
      losses: s.stats?.dailyLosses ?? 0,
      sampleRungs: (s.stats?.dailyWins ?? 0) + (s.stats?.dailyLosses ?? 0),
      realizedPnl: s.realizedPnl ?? 0,
    },
    startBalance: s.startBalance,
    openOrders: s.openOrders ?? 0,
    exchangeOpenOrders: s.exchangeOpenOrders ?? null,
    outOfRange: s.outOfRange ?? false,
    health: s.health ?? null,
    lastPrice: s.lastPrice,
    config: s.config,
  };
}

// ── 错误处理 ──────────────────────────────────────────────────────────────────
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[启动失败] 端口 ${cfg.port} 已被占用。`);
    console.error('请先关闭之前的程序窗口，或在 .env 里改 PORT=8081 用别的端口。\n');
  } else {
    console.error('[服务器错误] ' + (e?.message || e));
  }
  process.exit(1);
});

// ── 初始化各交易所 ────────────────────────────────────────────────────────────
async function initExchange(exchange, name, exCfg) {
  try {
    await exchange.init();
    console.log(`[${name}] ✓ 连接成功 [${exCfg.mode.toUpperCase()} 模式]`);
  } catch (e) {
    console.error(`\n[${name}] ✗ 初始化失败：${e?.message || e}`);
    console.error(`  目标接口: ${exCfg.apiUrl}   网络: ${exCfg.network}`);
    const cause = e?.cause || {};
    const code = cause.code || '';
    if (code === 'ENOTFOUND') {
      console.error('  ➤ 域名解析失败：检查网络，或配置代理。');
    } else if (code === 'ECONNREFUSED' && String(cause.address || '').includes('127.0.0.1')) {
      console.error('  ➤ 本机代理端口连不上，检查代理软件是否开启。');
    } else if (code === 'UND_ERR_CONNECT_TIMEOUT' || /timeout/i.test(cause.message || '')) {
      console.error('  ➤ 连接超时，接口被网络拦截，或代理未正确转发。');
    }
    console.error(`  该交易所将以离线模式运行（行情可能使用合成数据）。\n`);
    // 不退出，让其他交易所继续工作
  }
}

await Promise.all([
  initExchange(deExchange, 'Decibel', cfg.de),
  initExchange(exExchange, 'Extended', cfg.ex),
  initExchange(rsExchange, 'RISEx', cfg.rs),
]);

// ── 崩溃恢复 / 续跑 ────────────────────────────────────────────────────────────
// If a bot was "running" when the process died, RESUME it: re-attach to the
// orders still resting on the exchange and keep managing the grid. If resume
// fails (e.g. exchange offline), fall back to cancelling stray orders so we
// never operate a half-known grid.
async function resumeIfWasRunning(bot, exchange, key) {
  const snap = restoredSnapshots[key];
  if (!(snap?.running && snap?.config)) return;
  if (exchange.dataSource == null) {
    console.log(`[恢复] ${key.toUpperCase()} 交易所未连接，跳过续跑；保留挂单待下次连接。`);
    return;
  }
  try {
    if (exchange.mode === 'paper' && !snap.paperAccount && !Number.isFinite(Number(snap.legacyRealizedPnl))) {
      const aiState = loadSnapshot('ai');
      const baseline = aiState?.baseline;
      const baseRealized = baseline?.per?.[key]?.realizedPnl;
      if (Number.isFinite(Number(baseRealized))) {
        const afterBaseline = (snap.fills || [])
          .filter((fill) => Number(fill.t) > Number(baseline.t || 0))
          .reduce((sum, fill) => sum + (Number(fill.realizedPnl) || 0), 0);
        snap.legacyRealizedPnl = Number(baseRealized) + afterBaseline;
      }
    }
    console.log(`[恢复] 检测到 ${key.toUpperCase()} 上次为运行状态，正在接管续跑...`);
    await bot.resume(snap);
    console.log(`[恢复] ${key.toUpperCase()} 已续跑，接管挂单并完成对账。`);
  } catch (e) {
    console.error(`[恢复] ${key.toUpperCase()} 续跑失败（${e?.message || e}），改为撤销遗留挂单。`);
    await bot.recoverStrayOrders().catch(() => {});
  }
}
await Promise.all([
  resumeIfWasRunning(deBot, deExchange, 'de'),
  resumeIfWasRunning(exBot, exExchange, 'ex'),
  resumeIfWasRunning(rsBot, rsExchange, 'rs'),
]);

// After init, surface any LEFTOVER position so the dashboard can prompt the user
// (recovery ladder / re-grid / market close). Decibel & Extended RE-NUMBER their
// marketIds every run, so the persisted numeric id may point at the wrong market
// — re-resolve it by the market NAME, then start watching it so the position is
// polled into getState.
const _norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function detectOrphanPosition(bot, ex) {
  if (!bot.config?.displayName || ex.dataSource == null || typeof ex.getMarkets !== 'function') return;
  try {
    const markets = await ex.getMarkets();
    const want = _norm(bot.config.displayName);
    const m = markets.find((x) => _norm(x.displayName) === want || _norm(x.name) === want || _norm(x.symbol) === want);
    if (m) {
      bot.config.marketId = m.marketId;            // fix stale/ephemeral id -> current
      await ex.getPrice(m.marketId).catch(() => {}); // seed watch -> position gets polled
    }
  } catch { /* ignore */ }
}
await Promise.all([
  detectOrphanPosition(deBot, deExchange),
  detectOrphanPosition(exBot, exExchange),
  detectOrphanPosition(rsBot, rsExchange),
]);

server.listen(cfg.port, cfg.host, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : cfg.port;
  const publicHost = cfg.host === '0.0.0.0' ? 'localhost' : cfg.host;
  const dashboardUrl = `http://${publicHost}:${actualPort}`;
  console.log(`\n${'═'.repeat(52)}`);
  console.log(`  三交易所整合网格机器人 已启动`);
  console.log(`  仪表盘: ${dashboardUrl}`);
  if (cfg.host === '0.0.0.0') console.log('  ⚠ 当前监听所有网卡(0.0.0.0)，局域网内可访问，请确保有防护。');
  console.log(`${'═'.repeat(52)}`);
  console.log(`  Decibel  [${cfg.de.mode.toUpperCase()}]  ${cfg.de.network}`);
  console.log(`  Extended [${cfg.ex.mode.toUpperCase()}]  ${cfg.ex.network}`);
  console.log(`  RISEx    [${cfg.rs.mode.toUpperCase()}]  ${cfg.rs.network}`);
  console.log(`${'─'.repeat(52)}`);
  if (cfg.de.mode === 'paper' || cfg.ex.mode === 'paper' || cfg.rs.mode === 'paper') {
    console.log('  ⚠ 部分交易所为模拟模式，不涉及真实资金。');
    console.log('    在 .env 中设置 DE_MODE/EX_MODE/RS_MODE=live 切换实盘。');
  }
  console.log('');
  process.parentPort?.postMessage({
    type: 'server-ready',
    url: dashboardUrl,
    host: publicHost,
    port: actualPort,
  });
});

let shutdownStarted = false;

export async function shutdownServer() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  clearInterval(sseTimer);
  clearInterval(internalStrategyFallbackTimer);
  platformSpotFeed.unsubscribe();
  platformRiskFeed.unsubscribe();
  aiManagedService.stop();
  withdrawalPayoutService.stop();
  aiService.stop?.();
  for (const exchange of [deExchange, exExchange, rsExchange]) exchange.stop?.();
  flushState();
  if (!server.listening) return;
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
    setTimeout(resolve, 1500).unref?.();
  });
}

if (process.parentPort) {
  process.parentPort.on('message', (event) => {
    if (event.data?.type !== 'shutdown') return;
    shutdownServer().finally(() => process.exit(0));
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdownServer().finally(() => process.exit(0));
  });
}
