import { createAixTransaction } from './a-token-ledger.js';
import crypto from 'node:crypto';
import { formatUnits, parseUnits } from 'ethers';

// A 币生态主服务：定价、池元数据、销毁（通缩）、用户ID、profile 聚合
// A 币 18 位小数（BEP-20 标准），USDT 6 位小数
export const A_TOKEN_DECIMALS = 18;
export const USDT_DECIMALS = 6;
// 总量 20 亿枚，通缩 99%（销毁至仅剩 1% = 2000 万枚后停止销毁）
const TOTAL_SUPPLY = 2_000_000_000n * 10n ** BigInt(A_TOKEN_DECIMALS);
const BURN_CAP = 1_980_000_000n * 10n ** BigInt(A_TOKEN_DECIMALS); // 销毁上限 19.8 亿（总量的 99%）
// 每日固定销毁：当天各类销毁累计不足 100 万枚时，跨日结算自动补足到 100 万枚
const DAILY_BURN_TARGET = 1_000_000n * 10n ** BigInt(A_TOKEN_DECIMALS);
// 产出分配：50% 由激活包矿机产出，50% 由质押挖出，两个渠道各自封顶
const MINER_SHARE = TOTAL_SUPPLY / 2n; // 10 亿 — 矿机产出份额上限
const STAKE_SHARE = TOTAL_SUPPLY / 2n; // 10 亿 — 质押产出份额上限
// 默认 0.1 USDT/A，手续费 50%（50% 销毁 + 50% 进 A10 分红池，与 a-token-order-service / a-token-transfer-service 一致）
const DEFAULT_PRICE_USDT = '0.1';
const DEFAULT_FEE_RATE_BPS = 5000;
const BURN_RATE_BPS = 5000;     // 手续费中的销毁比例（50%）
const DIVIDEND_RATE_BPS = 5000; // 手续费中的 A10 分红池比例（50%）

const POOL_META_KEY = 'a_token_pool_meta';
const ACTIVATION_META_KEY = 'a_token_activation_meta';
const id = prefix => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const now = () => Date.now();

function parseA(value, label = 'A 币数量') {
  let result;
  try { result = parseUnits(String(value ?? '').trim(), A_TOKEN_DECIMALS); }
  catch { throw new Error(`${label}格式不正确`); }
  if (result <= 0n) throw new Error(`${label}必须大于 0`);
  return result;
}
function parseUsdt(value, label = 'USDT 数量') {
  // 规范化：先 Number 转一轮，避免科学计数 / 多余空格 / 'NaN' / 'Infinity' 字符串
  // 被 ethers parseUnits(6) 当成非法小数位；并在这里把诊断信息打出来便于排错
  const rawText = String(value ?? '').trim();
  let numericText = rawText;
  if (rawText.length > 0) {
    const numeric = Number(rawText);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      console.warn('[A币] parseUsdt 非法输入，label=', label, 'raw=', JSON.stringify(rawText), 'type=', typeof value, 'Number→', numeric);
      throw new Error(`${label}格式不正确`);
    }
    // 最大 6 位小数（USDT 精度），避免 8 位小数以上的字符串被 parseUnits 拒绝
    numericText = Number.isInteger(numeric)
      ? numeric.toString()
      : (+numeric.toFixed(USDT_DECIMALS)).toString();
  }
  let result;
  try { result = parseUnits(numericText, USDT_DECIMALS); }
  catch (e) {
    console.warn('[A币] parseUsdt ethers 解析失败 label=', label, 'raw=', JSON.stringify(rawText), 'normalized=', JSON.stringify(numericText), 'err=', e?.message || e);
    throw new Error(`${label}格式不正确`);
  }
  if (result <= 0n) throw new Error(`${label}必须大于 0`);
  return result;
}
// A 数量 → USDT 金额（按当前价格）
function aToUsdt(aUnits, priceUsdtUnits) {
  // priceUsdt 是 6 位小数的 USDT per A（1 A = priceUsdt USDT）
  // aUnits 是 18 位，price 是 6 位 → usdt = aUnits * price / 10^18
  return BigInt(aUnits) * BigInt(priceUsdtUnits) / (10n ** BigInt(A_TOKEN_DECIMALS));
}
// USDT 金额 → A 数量（按当前价格）
function usdtToA(usdtUnits, priceUsdtUnits) {
  if (BigInt(priceUsdtUnits) <= 0n) return 0n;
  // a = usdt * 10^18 / price
  return BigInt(usdtUnits) * (10n ** BigInt(A_TOKEN_DECIMALS)) / BigInt(priceUsdtUnits);
}
/**
 * 宽松解析 A 币 USDT 单价：失败 / 非法时 返回默认价，不抛错。
 * 用于所有"自动链路"（K 线 tick / 种子重建 / 撮合写回）避免一轮坏数据把整条定时器卡死。
 */
function safeParsePriceUsdt(usdtPerA, fallback = DEFAULT_PRICE_USDT) {
  const numeric = Number(String(usdtPerA ?? '').trim());
  if (!Number.isFinite(numeric) || numeric <= 0 || Number.isNaN(numeric)) {
    console.warn('[A币] 价格非法，使用默认价', fallback, '入参=', JSON.stringify(usdtPerA), 'type=', typeof usdtPerA);
    return String(fallback);
  }
  return (+numeric.toFixed(USDT_DECIMALS)).toString();
}

export function createATokenService({ database, walletService, clock = () => Date.now() }) {
  const db = database;
  const transaction = createAixTransaction(database, walletService);

  // ── 池元数据（定价/统计） ──
  function defaultPoolMeta() {
    return {
      priceUsdt: DEFAULT_PRICE_USDT,
      feeRateBps: DEFAULT_FEE_RATE_BPS,
      burnRateBps: BURN_RATE_BPS,
      dividendRateBps: DIVIDEND_RATE_BPS,
      totalSupplyUnits: TOTAL_SUPPLY.toString(),
      treasuryBalanceUnits: '0',     // 平台做市钱包持有的 A（链上，第二期对接）
      totalMintedUnits: '0',         // 累计已铸造 A（仅买入时增加，用于总量上限校验）
      minerMintedUnits: '0',         // 矿机（激活包）产出累计，≤ MINER_SHARE
      stakeMintedUnits: '0',         // 质押产出累计，≤ STAKE_SHARE
      treasuryUsdtUnits: '0',         // 平台做市 USDT 储备（买入+，卖出-）
      totalBurnedUnits: '0',         // 累计已销毁 A（运行总额,避免 SUM(CAST AS INTEGER) 在 18 位小数下溢出 int64）
      burnDate: new Date(clock()).toISOString().slice(0, 10), // 今日销毁统计日（UTC 日期，跨日结算补足）
      todayBurnedUnits: '0',         // 今日已销毁 A（含手续费/跟单解锁等全部销毁来源）
      burnEnabled: '0',              // 每日固定销毁补足开关：'1'=开启（每日各类销毁不足100万枚自动补足）；'0'=暂停补足。手续费/VIP 销毁固定执行，不受此开关影响
      todayVolumeAUnits: '0',        // 今日交易量（A）
      todayVolumeUsdtUnits: '0',     // 今日交易量（USDT）
      todayDate: new Date(clock()).toISOString().slice(0, 10),
      lastPriceUpdateAt: clock(),
      adminOverrides: {},            // 后台调控的交易数据覆盖
    };
  }
  function getPoolMeta() {
    const raw = db.db.prepare('SELECT payload_json FROM service_settings WHERE setting_key=?').get(POOL_META_KEY);
    const meta = raw ? JSON.parse(raw.payload_json) : defaultPoolMeta();
    const merged = { ...defaultPoolMeta(), ...meta };
    // 价格兜底：若数据库存了坏值（NaN/空串/≤0）立刻改回 DEFAULT，避免上一层 parseUsdt 直接抛
    if (!Number(merged.priceUsdt) > 0 || !Number.isFinite(Number(merged.priceUsdt))) {
      console.warn('[A币] getPoolMeta 读到坏价格:', JSON.stringify(merged.priceUsdt), '已重置为', DEFAULT_PRICE_USDT);
      merged.priceUsdt = DEFAULT_PRICE_USDT;
    }
    return merged;
  }
  function savePoolMeta(meta) {
    db.db.prepare('INSERT INTO service_settings(setting_key,payload_json,updated_at) VALUES(?,?,?) ON CONFLICT(setting_key) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at')
      .run(POOL_META_KEY, JSON.stringify(meta), clock());
  }
  function readActivationSettings() {
    const raw = db.db.prepare('SELECT payload_json FROM service_settings WHERE setting_key=?').get(ACTIVATION_META_KEY);
    return raw ? JSON.parse(raw.payload_json) : {};
  }
  // 前台「激活名额进度」展示值：名额总数 cap 可由后台设定；
  // 已激活人数 = 真实确认激活数 + 后台补量（activatedCountOffset），
  // 补量按差值存储，真实新增激活仍会继续累加。
  function getActivationMeta() {
    const stored = readActivationSettings();
    const real = db.countConfirmedATokenActivations();
    const cap = Math.max(1, Math.floor(Number(stored.cap)) || 1_000_000);
    const offset = Math.max(0, Math.floor(Number(stored.activatedCountOffset)) || 0);
    return { cap: null, unlimited: true, paymentMode: 'aix_balance', legacyCap: cap, activatedCount: real + offset, activatedCountReal: real, updatedAt: stored.updatedAt || null };
  }
  // 后台设置激活进度：activatedCount 传「前台应显示的人数」，内部换算成差值落库
  function setActivationMeta({ cap, activatedCount } = {}) {
    const stored = readActivationSettings();
    const real = db.countConfirmedATokenActivations();
    const nextCap = cap !== undefined && Number.isFinite(Number(cap))
      ? Math.max(1, Math.floor(Number(cap)))
      : Math.max(1, Math.floor(Number(stored.cap)) || 1_000_000);
    const current = real + Math.max(0, Math.floor(Number(stored.activatedCountOffset)) || 0);
    const nextCount = activatedCount !== undefined && Number.isFinite(Number(activatedCount))
      ? Math.max(0, Math.floor(Number(activatedCount)))
      : current;
    db.db.prepare('INSERT INTO service_settings(setting_key,payload_json,updated_at) VALUES(?,?,?) ON CONFLICT(setting_key) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at')
      .run(ACTIVATION_META_KEY, JSON.stringify({ cap: nextCap, activatedCountOffset: nextCount - real, updatedAt: clock() }), clock());
    return getActivationMeta();
  }
  function getPriceUsdtUnits() {
    const meta = getPoolMeta();
    return parseUsdt(meta.priceUsdt, 'A 币价格');
  }
  function setPrice(usdtPerA) {
    // 自动链路：不抛错。非法就落回 DEFAULT_PRICE_USDT，保证 K 线/撮合不被坏数据一轮打断。
    const safePrice = safeParsePriceUsdt(usdtPerA, DEFAULT_PRICE_USDT);
    // 再走一次 parseUsdt 验证（含规范化），一般不会失败；若失败再兜底 DEFAULT
    let price;
    try { price = parseUsdt(safePrice, 'A 币价格'); }
    catch (e) {
      console.warn('[A币] setPrice parseUsdt 二次校验失败，使用默认价:', DEFAULT_PRICE_USDT, '入参=', JSON.stringify(usdtPerA), 'safe=', safePrice);
      price = parseUsdt(DEFAULT_PRICE_USDT, 'A 币价格');
    }
    const meta = getPoolMeta();
    meta.priceUsdt = formatUnits(price, USDT_DECIMALS);
    meta.lastPriceUpdateAt = clock();
    savePoolMeta(meta);
    return meta;
  }
  function setPoolMeta(patch) {
    const meta = { ...getPoolMeta(), ...patch };
    savePoolMeta(meta);
    return meta;
  }
  // 滚动今日交易量（跨日清零）
  function rollTodayVolume(meta) {
    const today = new Date(clock()).toISOString().slice(0, 10);
    if (meta.todayDate !== today) {
      meta.todayDate = today;
      meta.todayVolumeAUnits = '0';
      meta.todayVolumeUsdtUnits = '0';
    }
    return meta;
  }
  function addTodayVolume(meta, aUnits, usdtUnits) {
    meta = rollTodayVolume(meta);
    meta.todayVolumeAUnits = (BigInt(meta.todayVolumeAUnits) + BigInt(aUnits)).toString();
    meta.todayVolumeUsdtUnits = (BigInt(meta.todayVolumeUsdtUnits) + BigInt(usdtUnits)).toString();
    return meta;
  }
  // 原子累加今日交易量（读-改-写一次完成，避免跨调用 stale meta 覆盖）
  function addVolume(aUnits, usdtUnits) {
    const meta = rollTodayVolume(getPoolMeta());
    meta.todayVolumeAUnits = (BigInt(meta.todayVolumeAUnits) + BigInt(aUnits)).toString();
    meta.todayVolumeUsdtUnits = (BigInt(meta.todayVolumeUsdtUnits) + BigInt(usdtUnits)).toString();
    savePoolMeta(meta);
    return meta;
  }
  // 累计铸造 A（仅买入时调用），返回铸造后总量；超出 TOTAL_SUPPLY 抛错
  function addMinted(units) {
    const amount = BigInt(units);
    if (amount <= 0n) return BigInt(getPoolMeta().totalMintedUnits);
    const meta = getPoolMeta();
    const next = BigInt(meta.totalMintedUnits) + amount;
    if (next > TOTAL_SUPPLY) throw new Error('A 币总量已达上限，无法继续铸造');
    meta.totalMintedUnits = next.toString();
    savePoolMeta(meta);
    return next;
  }
  function getMintedRemaining() { return TOTAL_SUPPLY - BigInt(getPoolMeta().totalMintedUnits); }
  // 平台做市 USDT 储备变动（买入+，卖出-）
  function moveTreasuryUsdt(deltaUnits) {
    const delta = BigInt(deltaUnits);
    const meta = getPoolMeta();
    const next = BigInt(meta.treasuryUsdtUnits) + delta;
    if (next < 0n) throw new Error('平台 USDT 储备不足，暂时无法兑付');
    meta.treasuryUsdtUnits = next.toString();
    savePoolMeta(meta);
    return next;
  }

  // ── 销毁（通缩）──
  function totalBurned() { return BigInt(getPoolMeta().totalBurnedUnits); }
  function isBurnEnabled() { const v = getPoolMeta().burnEnabled; return v === '1' || v === 1 || v === true; }
  // 矿机激活 / AIX 提现 总开关（缺省视为开启，仅显式 '0'/false 时关闭）
  function isActivationEnabled() { const v = getPoolMeta().activationEnabled; return v === undefined || v === '1' || v === 1 || v === true; }
  function isWithdrawEnabled() { const v = getPoolMeta().withdrawEnabled; return v === undefined || v === '1' || v === 1 || v === true; }
  function isDeflationActive() { return totalBurned() < BURN_CAP; }
  function addBurned(units) {
    const amount = BigInt(units);
    if (amount <= 0n) return;
    const meta = getPoolMeta();
    meta.totalBurnedUnits = (BigInt(meta.totalBurnedUnits) + amount).toString();
    savePoolMeta(meta);
  }
  // 跨日结算：上一天销毁累计不足 100 万枚的部分固定补足销毁（幂等，按 burnDate 判定）
  // 销毁开关关闭时：只滚动日期，不做补足销毁
  function settleDailyBurn() {
    const meta = getPoolMeta();
    const today = new Date(clock()).toISOString().slice(0, 10);
    const prevDate = meta.burnDate || today;
    if (prevDate === today) return meta;
    const prevBurned = BigInt(meta.todayBurnedUnits || '0');
    const shortfall = DAILY_BURN_TARGET - prevBurned;
    meta.burnDate = today;
    meta.todayBurnedUnits = '0';
    if (shortfall > 0n && isBurnEnabled()) {
      const capLeft = BURN_CAP - BigInt(meta.totalBurnedUnits);
      const makeup = shortfall < capLeft ? shortfall : capLeft; // 受 99% 通缩上限约束
      if (makeup > 0n) {
        db.insertATokenBurnRow({ id: id('atb'), source: 'daily_fixed', reason: `每日固定销毁补足（${prevDate} 销毁未达 100 万枚）`, amountUnits: makeup.toString(), createdAt: clock() });
        meta.totalBurnedUnits = (BigInt(meta.totalBurnedUnits) + makeup).toString();
      }
    }
    savePoolMeta(meta);
    return meta;
  }
  function burn(amountA, source, reason) {
    const amount = BigInt(amountA);
    if (amount <= 0n) return 0n;
    const meta = settleDailyBurn();
    const capLeft = BURN_CAP - BigInt(meta.totalBurnedUnits);
    const actualBurn = capLeft > 0n ? (amount < capLeft ? amount : capLeft) : 0n;
    if (actualBurn > 0n) {
      db.insertATokenBurnRow({ id: id('atb'), source, reason, amountUnits: actualBurn.toString(), createdAt: clock() });
      meta.totalBurnedUnits = (BigInt(meta.totalBurnedUnits) + actualBurn).toString();
      meta.todayBurnedUnits = (BigInt(meta.todayBurnedUnits || '0') + actualBurn).toString();
      savePoolMeta(meta);
    }
    return actualBurn;
  }

  // ── 用户ID（8 位数字+字母）──
  function ensureUserId(wallet) {
    const normalized = String(wallet || '').toLowerCase();
    walletService.ensureUser(normalized); // 先在 wallet_users 建用户,避免 FK 约束失败
    const existing = db.getATokenUserIdByWallet(normalized);
    if (existing) return existing;
    // 生成 8 位字母数字 ID，冲突重试
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混字符
      let userId = '';
      const bytes = crypto.randomBytes(8);
      for (let i = 0; i < 8; i += 1) userId += chars[bytes[i] % chars.length];
      if (!db.getATokenUserId(userId)) {
        const row = { wallet: normalized, userId, createdAt: clock() };
        db.upsertATokenUserIdRow(row);
        return row;
      }
    }
    throw new Error('用户 ID 生成失败，请重试');
  }
  function getUserId(userId) { return db.getATokenUserId(userId); }
  function walletForUserId(userId) {
    const row = db.getATokenUserId(String(userId || '').trim());
    return row?.wallet || null;
  }

  // ── 余额工具 ──
  function balanceA(wallet) { return walletService.balanceUnits(wallet, 'A'); }
  function balanceUsdt(wallet) { return walletService.balanceUnits(wallet, 'USDT'); }
  function creditA(wallet, units) { walletService.creditBalance(wallet, 'A', units); }
  // ── 产出份额入账：激活矿机/质押各占总量 50%，渠道额度挖完即停止发放（尾部截断） ──
  function mintByShare(metaKey, capUnits, wallet, units) {
    const amount = BigInt(units);
    if (amount <= 0n) return '0';
    const meta = getPoolMeta();
    const used = BigInt(meta[metaKey] || '0');
    const remain = capUnits - used;
    if (remain <= 0n) return '0'; // 该渠道份额已挖完
    const grant = amount < remain ? amount : remain;
    meta[metaKey] = (used + grant).toString();
    savePoolMeta(meta);
    walletService.creditBalance(wallet, 'A', grant.toString());
    return grant.toString();
  }
  function creditMinerA(wallet, units) { return mintByShare('minerMintedUnits', MINER_SHARE, wallet, units); }
  function creditStakingA(wallet, units) { return mintByShare('stakeMintedUnits', STAKE_SHARE, wallet, units); }
  function debitA(wallet, units) { walletService.debitBalance(wallet, 'A', units); }
  function creditUsdt(wallet, units) { walletService.creditBalance(wallet, 'USDT', units); }
  function debitUsdt(wallet, units) { walletService.debitBalance(wallet, 'USDT', units); }

  // ── profile 聚合（前端赚取/交易页用）──
  async function profile(wallet) {
    const meta = settleDailyBurn();
    const normalized = String(wallet || '').toLowerCase();
    const userIdRow = ensureUserId(wallet);
    const miners = db.listATokenMiners(wallet);
    const stakes = db.listATokenStakes(wallet);
    const trades = db.listATokenTradesByWallet(wallet, 50);
    const transfers = db.listATokenTransfers(wallet, 50);
    const activations = (db.listATokenActivationsByWallet?.(wallet) || []).map(a => ({ ...a }));
    const teamLevel = db.getATokenTeamLevel(wallet);
    const recentTrades = db.listATokenTrades(20);
    const burned = totalBurned();
    const burnedPct = TOTAL_SUPPLY > 0n ? Number(burned * 10_000n / TOTAL_SUPPLY) / 100 : 0;
    return {
      wallet,
      userId: userIdRow.userId,
      balances: {
        A: formatUnits(balanceA(wallet), A_TOKEN_DECIMALS),
        USDT: formatUnits(balanceUsdt(wallet), USDT_DECIMALS),
      },
      price: { usdtPerA: meta.priceUsdt, lastUpdate: meta.lastPriceUpdateAt },
      pool: {
        priceUsdt: meta.priceUsdt,
        feeRateBps: meta.feeRateBps,
        todayVolumeA: formatUnits(BigInt(meta.todayVolumeAUnits), A_TOKEN_DECIMALS),
        todayVolumeUsdt: formatUnits(BigInt(meta.todayVolumeUsdtUnits), USDT_DECIMALS),
        dividendPool: a10PoolPendingA(),
        totalSupply: formatUnits(TOTAL_SUPPLY, A_TOKEN_DECIMALS),
        totalBurned: formatUnits(burned, A_TOKEN_DECIMALS),
        todayBurned: formatUnits(BigInt(meta.todayBurnedUnits || '0'), A_TOKEN_DECIMALS),
        dailyBurnTarget: formatUnits(DAILY_BURN_TARGET, A_TOKEN_DECIMALS),
        todayBurnLeft: formatUnits(DAILY_BURN_TARGET - BigInt(meta.todayBurnedUnits || '0') > 0n ? DAILY_BURN_TARGET - BigInt(meta.todayBurnedUnits || '0') : 0n, A_TOKEN_DECIMALS),
        burnedPct,
        deflationActive: isDeflationActive(),
      },
      miners: miners.map(m => ({ ...m, total: formatUnits(BigInt(m.totalUnits), A_TOKEN_DECIMALS), dailyTarget: formatUnits(BigInt(m.dailyTargetUnits), A_TOKEN_DECIMALS), dayEarned: formatUnits(BigInt(m.dayEarnedUnits), A_TOKEN_DECIMALS), totalEarned: formatUnits(BigInt(m.totalEarnedUnits), A_TOKEN_DECIMALS) })),
      stakes: stakes.map(s => ({ ...s, principal: formatUnits(BigInt(s.principalUnits), A_TOKEN_DECIMALS), dayEarned: formatUnits(BigInt(s.dayEarnedUnits), A_TOKEN_DECIMALS), totalEarned: formatUnits(BigInt(s.totalEarnedUnits), A_TOKEN_DECIMALS) })),
      trades: trades.map(t => ({ ...t, size: formatUnits(BigInt(t.sizeUnits), A_TOKEN_DECIMALS), priceUsdt: formatUnits(BigInt(t.priceUsdtUnits), USDT_DECIMALS), amountUsdt: formatUnits(BigInt(t.amountUsdtUnits), USDT_DECIMALS), fee: formatUnits(BigInt(t.feeUnits), A_TOKEN_DECIMALS), burn: t.burnUnits ? formatUnits(BigInt(t.burnUnits), A_TOKEN_DECIMALS) : '0', dividend: t.dividendUnits ? formatUnits(BigInt(t.dividendUnits), A_TOKEN_DECIMALS) : '0' })),
      transfers: transfers.map(t => ({ ...t, amount: formatUnits(BigInt(t.amountUnits), A_TOKEN_DECIMALS), fee: formatUnits(BigInt(t.feeUnits), A_TOKEN_DECIMALS), direction: String(t.fromWallet).toLowerCase() === normalized ? 'out' : 'in' })),
      activations,
      teamLevel: teamLevel ? { ...teamLevel, personalHeld: formatUnits(BigInt(teamLevel.personalHeldUnits), A_TOKEN_DECIMALS), teamHeld: formatUnits(BigInt(teamLevel.teamHeldUnits), A_TOKEN_DECIMALS) } : null,
      recentTrades: recentTrades.map(t => ({ ...t, size: formatUnits(BigInt(t.sizeUnits), A_TOKEN_DECIMALS), priceUsdt: formatUnits(BigInt(t.priceUsdtUnits), USDT_DECIMALS), amountUsdt: formatUnits(BigInt(t.amountUsdtUnits), USDT_DECIMALS) })),
    };
  }

  // A10 团队分红池当前待结余额（a_token_a10_pool 表，日结时清零重计）
  function a10PoolPendingA() {
    try {
      const pool = db.getA10Pool('current');
      return formatUnits(BigInt(pool?.accumUnits || '0'), A_TOKEN_DECIMALS);
    } catch { return '0'; }
  }

  function poolStats() {
    const meta = settleDailyBurn();
    const burned = BigInt(meta.totalBurnedUnits);
    const todayBurned = BigInt(meta.todayBurnedUnits || '0');
    const todayBurnLeft = DAILY_BURN_TARGET - todayBurned > 0n ? DAILY_BURN_TARGET - todayBurned : 0n;
    // 矿池总览：active 矿机数、总算力、累计产出、按 plan 分档
    let miner = null;
    try { miner = db.minerStats(); } catch (e) { /* database 未注入或表不存在 */ }
    const formatMiner = m => m ? {
      activeCount: m.activeCount,
      totalMinersAllTime: m.totalMinersAllTime,
      totalHashrate: formatUnits(BigInt(m.totalHashrateUnits || '0'), A_TOKEN_DECIMALS),
      totalEarnedActive: formatUnits(BigInt(m.totalEarnedActiveUnits || '0'), A_TOKEN_DECIMALS),
      totalPlanned: formatUnits(BigInt(m.totalPlannedUnits || '0'), A_TOKEN_DECIMALS),
      lifetimeEarned: formatUnits(BigInt(m.lifetimeEarnedUnits || '0'), A_TOKEN_DECIMALS),
      byPlan: Object.fromEntries(Object.entries(m.byPlan || {}).map(([k, v]) => [k, {
        activeCount: v.activeCount,
        dailyTarget: formatUnits(BigInt(v.dailyTargetUnits || '0'), A_TOKEN_DECIMALS),
        totalEarned: formatUnits(BigInt(v.totalEarnedUnits || '0'), A_TOKEN_DECIMALS),
        total: formatUnits(BigInt(v.totalUnits || '0'), A_TOKEN_DECIMALS),
        remaining: formatUnits(BigInt(v.remainingUnits || '0'), A_TOKEN_DECIMALS),
      }])),
    } : null;
    // 24h 涨跌：现价 vs 24h 前 1h K 线开盘价（真实价格轨迹）。
    // 不用 recentTrades 当基准：成交回报稀疏且时段不固定，算出来的"24h 涨跌"会与 K 线走势对不上（2026-10-21 事故）。
    let changePct24h = null;
    // 24h 最高/最低：近 24h 的 1h K 线 high/low 极值，再并入当前价（最新 bar 可能还没收录最新 tick）。
    // 2026-10-24 修复：此前 poolStats 根本没返回 todayHigh/todayLow，前端只能兜底显示现价 → 最高/最低永远等于现价。
    let todayHigh = null, todayLow = null;
    try {
      const cutoff = Math.floor(Date.now() / 1000) - 86_400;
      const hourBars = db.listATokenKlines?.('1h', 26) || [];
      let ref = 0;
      for (let i = hourBars.length - 1; i >= 0; i--) {
        if (Number(hourBars[i].time) <= cutoff) { ref = Number(hourBars[i].open); break; }
      }
      if (!(ref > 0) && hourBars.length) ref = Number(hourBars[0].open); // 历史不足 24h 时用最早可得
      const cur = Number(meta.priceUsdt);
      if (ref > 0 && cur > 0) changePct24h = (cur - ref) / ref * 100;
      let hi = 0, lo = 0;
      for (const bar of hourBars) {
        if (Number(bar.time) + 3600 <= cutoff) continue; // 与近 24h 窗口不重叠的 bar 跳过
        const h = Number(bar.high), l = Number(bar.low);
        if (h > 0 && (hi === 0 || h > hi)) hi = h;
        if (l > 0 && (lo === 0 || l < lo)) lo = l;
      }
      if (cur > 0) { if (hi === 0 || cur > hi) hi = cur; if (lo === 0 || cur < lo) lo = cur; }
      if (hi > 0) todayHigh = String(hi);
      if (lo > 0) todayLow = String(lo);
    } catch { changePct24h = null; }
    return {
      priceUsdt: meta.priceUsdt,
      changePct24h,
      todayHigh,
      todayLow,
      feeRateBps: meta.feeRateBps,
      burnRateBps: meta.burnRateBps,
      dividendRateBps: meta.dividendRateBps,
      todayVolumeA: formatUnits(BigInt(meta.todayVolumeAUnits), A_TOKEN_DECIMALS),
      todayVolumeUsdt: formatUnits(BigInt(meta.todayVolumeUsdtUnits), USDT_DECIMALS),
      dividendPool: a10PoolPendingA(),
      totalSupply: formatUnits(TOTAL_SUPPLY, A_TOKEN_DECIMALS),
      totalMinted: formatUnits(BigInt(meta.totalMintedUnits), A_TOKEN_DECIMALS),
      mintedRemaining: formatUnits(getMintedRemaining(), A_TOKEN_DECIMALS),
      // 产出份额：矿机/质押各占总量 50%
      minerShareUsed: formatUnits(BigInt(meta.minerMintedUnits || '0'), A_TOKEN_DECIMALS),
      minerShareCap: formatUnits(MINER_SHARE, A_TOKEN_DECIMALS),
      minerShareLeft: formatUnits(MINER_SHARE - BigInt(meta.minerMintedUnits || '0'), A_TOKEN_DECIMALS),
      stakeShareUsed: formatUnits(BigInt(meta.stakeMintedUnits || '0'), A_TOKEN_DECIMALS),
      stakeShareCap: formatUnits(STAKE_SHARE, A_TOKEN_DECIMALS),
      stakeShareLeft: formatUnits(STAKE_SHARE - BigInt(meta.stakeMintedUnits || '0'), A_TOKEN_DECIMALS),
      treasuryUsdt: formatUnits(BigInt(meta.treasuryUsdtUnits), USDT_DECIMALS),
      totalBurned: formatUnits(burned, A_TOKEN_DECIMALS),
      todayBurned: formatUnits(todayBurned, A_TOKEN_DECIMALS),
      burnEnabled: isBurnEnabled(),
      activationEnabled: isActivationEnabled(),
      withdrawEnabled: isWithdrawEnabled(),
      dailyBurnTarget: formatUnits(DAILY_BURN_TARGET, A_TOKEN_DECIMALS),
      todayBurnLeft: formatUnits(todayBurnLeft, A_TOKEN_DECIMALS),
      burnedPct: TOTAL_SUPPLY > 0n ? Number(burned * 10_000n / TOTAL_SUPPLY) / 100 : 0,
      deflationActive: isDeflationActive(),
      minerStats: formatMiner(miner),
      recentTrades: db.listATokenTrades(20).map(t => ({ ...t, size: formatUnits(BigInt(t.sizeUnits), A_TOKEN_DECIMALS), priceUsdt: formatUnits(BigInt(t.priceUsdtUnits), USDT_DECIMALS), amountUsdt: formatUnits(BigInt(t.amountUsdtUnits), USDT_DECIMALS) })),
    };
  }

  return {
    // 定价与池元数据
    getPriceUsdtUnits, setPrice, getPoolMeta, setPoolMeta, poolStats,
    addTodayVolume, rollTodayVolume, addVolume, addMinted, getMintedRemaining, moveTreasuryUsdt,
    // 销毁
    burn, isDeflationActive, totalBurned, settleDailyBurn, isBurnEnabled, isActivationEnabled, isWithdrawEnabled,
    // 用户ID
    ensureUserId, getUserId, walletForUserId,
    // 余额工具
    transaction, balanceA, balanceUsdt, creditA, debitA, creditUsdt, debitUsdt,
    creditMinerA, creditStakingA, MINER_SHARE, STAKE_SHARE,
    // 转换
    aToUsdt, usdtToA, parseA, parseUsdt,
    // 聚合
    profile,
    // 激活元数据
    getActivationMeta, setActivationMeta,
    // 常量
    TOTAL_SUPPLY, BURN_CAP, DAILY_BURN_TARGET, A_TOKEN_DECIMALS, USDT_DECIMALS,
  };
}
