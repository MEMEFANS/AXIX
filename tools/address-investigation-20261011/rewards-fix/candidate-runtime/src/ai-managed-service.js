import crypto from 'node:crypto';
import { formatUnits, parseUnits } from 'ethers';
import { A_TOKEN_DECIMALS } from './a-token-service.js';

export const AI_MANAGED_KEY = 'ai-managed';
export const AI_MANAGED_SLOT_MS = 72 * 60_000;
// 合约跟单 VIP 会员：销毁 1000 枚 AIX 开通 30 天 VIP，VIP 有效才能跟单；到期后续费需重新销毁 1000 枚（永久销毁不返还）
export const COPY_TRADE_UNLOCK_A = 1000n * 10n ** BigInt(A_TOKEN_DECIMALS);
export const COPY_TRADE_UNLOCK_DAYS = 30;
// 资产入账节奏：不每笔 slot 入账，而是每 8 小时窗口汇总入账一次（一天约 3 条结算流水，UTC+8 的 0/8/16 点）。
const AI_CREDIT_WINDOW_MS = 8 * 60 * 60_000;
// 统一锁仓期 30 天，月化 20%-25% 随机（每个批次独立），无到期日
const AI_MANAGED_LOCK_DAYS = 30;
const AI_MANAGED_MONTHLY_MIN = 20; // 月化下限 20%
const AI_MANAGED_MONTHLY_MAX = 25; // 月化上限 25%
// 兼容旧代码导出
export const AI_MANAGED_PLANS = Object.freeze({ 360: { days:360, rateBps:75 } });
const USDT_DECIMALS = 6;
const DAY_MS = 24 * 60 * 60_000;
const MAX_RECORDS = 1000;
const id = prefix => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const iso = t => new Date(t).toISOString();

function amount(value, label = '金额') {
  let result;
  try { result = parseUnits(String(value ?? '').trim(), USDT_DECIMALS); } catch { throw new Error(`${label}格式不正确`); }
  if (result <= 0n) throw new Error(`${label}必须大于 0`);
  return result;
}
function planFor(value) {
  // 随机月化 20%-25%，换算为日化 bps（1 bp = 0.01%）
  const monthlyPct = AI_MANAGED_MONTHLY_MIN + Math.floor(crypto.randomBytes(2).readUInt16LE() / 65536 * (AI_MANAGED_MONTHLY_MAX - AI_MANAGED_MONTHLY_MIN + 1));
  const dailyBps = Math.round(monthlyPct / 30 * 100); // e.g. 22% / 30 = 0.733% → 73 bps
  return { days: AI_MANAGED_LOCK_DAYS, rateBps: dailyBps, monthlyPct };
}
function startOfDay(t, offset, dayMs = DAY_MS) { return Math.floor((t + offset) / dayMs) * dayMs - offset; }
function candleFor(candles, t) {
  const eligible = candles.filter(item => Number(item?.time) <= t).slice(-16);
  return eligible.reduce((best, item) => {
    if (!best) return item;
    const bestMove = Math.abs(Number(best.close || best.open || 0) - Number(best.open || best.close || 0));
    const itemMove = Math.abs(Number(item.close || item.open || 0) - Number(item.open || item.close || 0));
    return itemMove >= bestMove ? item : best;
  }, null) || candles.at(-1) || null;
}

function emptyState(now, offset) {
  return { key:AI_MANAGED_KEY, name:'AI 托管策略', running:false, autoCompound:false,
    batches:[], records:[], totalEarnedUnits:'0', lastSlotAt:now, startedAt:null, updatedAt:iso(now),
    capitalUnits:'0', cashUnits:'0', inventoryUnits:'0', realizedPnlUnits:'0', lastPriceUnits:'0', badDebtUnits:'0',
    config:{ slotMinutes:72, plans:AI_MANAGED_PLANS } };
}

export function createAiManagedService({ platformService, walletService, fetchCandles,
  referralService = null, aTokenService = null, clock = () => Date.now(), slotMs = AI_MANAGED_SLOT_MS, dayMs = DAY_MS, timezoneOffsetMs = 8 * 60 * 60_000 }) {
  const slotsPerDay = Math.max(1, Math.round(dayMs / slotMs));
  let processing = null;
  const db = platformService.database;
  async function candleSets() {
    const [btc, eth] = await Promise.all([
      fetchCandles('BTC', 300, 300).catch(e => { console.error('[AI托管] BTC K线获取失败:', e?.message || e); return []; }),
      fetchCandles('ETH', 300, 300).catch(e => { console.error('[AI托管] ETH K线获取失败:', e?.message || e); return []; }),
    ]);
    return { BTC:btc, ETH:eth };
  }
  function normalizedCandleSets(value) {
    if (Array.isArray(value)) return { BTC:value, ETH:value };
    return value && typeof value === 'object' ? value : { BTC:[], ETH:[] };
  }
  function seededValue(batch, t, salt = 0) {
    const slotNumber = Math.trunc(t / Math.max(1, slotMs));
    const batchSeed = [...String(batch.id || '')].reduce((value, char) => Math.imul(value ^ char.charCodeAt(0), 16_777_619) >>> 0, 2_166_136_261);
    let value = (batchSeed ^ slotNumber ^ salt) >>> 0;
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return value >>> 0;
  }
  // 每个 slot 的间隔做确定性随机抖动：基准 72 分钟，实际约 45~99 分钟。
  // 种子绑定 batch + 具体时间戳，重启/补算重放结果一致；XOR 混入 t 避免相邻 slot 种子重复导致周期循环。
  function slotIntervalMs(batch, t) {
    const mixed = (seededValue(batch, t, 0x2545f491) ^ (Number.isFinite(t) ? Math.trunc(t) : 0)) >>> 0;
    const jitter = mixed % 1001; // 0..1000
    const min = slotMs * 0.62, max = slotMs * 1.38;
    return Math.round(min + (max - min) * (jitter / 1000));
  }
  // 真实模拟交易执行：基于历史 K 线开/收价与方向判断，计算真实盈亏（可为负）。
  // 注：predictErrorBps 模拟"信号判断与实际走势的偏差"，让胜率落在 60~75% 区间。
  function executionDetails(batch, t, candle, plannedReward, forcedDirection = '') {
    const rawOpen = Number(candle?.open || candle?.close || candle?.price || 0);
    const rawClose = Number(candle?.close || rawOpen);
    const openPrice = rawOpen > 0 ? rawOpen : 1;
    const closePrice = rawClose > 0 ? rawClose : openPrice;
    const seed = Math.abs(Math.trunc(t / Math.max(1, slotMs) + openPrice));
    const leverage = 3 + seed % 8;
    // 信号方向：85% 概率跟随实际走势（赢），15% 反向（亏）——模拟真实策略胜率
    const followsTrend = (seed % 100) < 85;
    const actualUp = closePrice > openPrice;
    let direction;
    if (actualUp) direction = followsTrend ? '多' : '空';
    else if (closePrice < openPrice) direction = followsTrend ? '空' : '多';
    else direction = forcedDirection === '多' || forcedDirection === '空' ? forcedDirection : (seed % 2 === 0 ? '多' : '空');
    // 真实价差（带方向符号）：多单 = close - open，空单 = open - close
    const signedMove = direction === '多' ? (closePrice - openPrice) : (openPrice - closePrice);
    const priceMovePct = openPrice > 0 ? signedMove / openPrice * 100 : 0;
    // 仓位规模：以"计划 reward 等效名义价值"为锚，按杠杆放大仓位
    // 让单 slot 期望盈亏 ≈ plannedReward，但实际盈亏随价差波动（大赚小亏）
    const plannedRewardValue = Number(formatUnits(plannedReward, USDT_DECIMALS));
    // 用历史波动率估算"标准价差%"
    const absMovePct = Math.abs(priceMovePct) > 0.0001 ? Math.abs(priceMovePct) : 0.15;
    // 目标仓位：85% 胜率 + 1:1 盈亏比 → 期望 = 0.7×X，令 X ≈ plannedReward/0.7 ≈ 1.43R
    // 取 1.5 略偏正，让赢利记录稍大于亏损记录，符合跟单策略视觉预期
    const targetNotional = plannedRewardValue * 1.5 / Math.max(0.05, absMovePct) * 100;
    const size = targetNotional / openPrice;
    const margin = size * openPrice / leverage;
    const notional = size * openPrice;
    // 真实 PnL = 仓位 × 价差（带方向符号）
    const pnlValue = size * signedMove;
    return { direction, side:direction === '多' ? 'buy' : 'sell', openPrice, closePrice, price:closePrice,
      size, leverage, margin, notional, priceMovePct, pnlValue };
  }
  function read(address) {
    const old = platformService.internalStrategyState(address, AI_MANAGED_KEY);
    const state = { ...emptyState(clock(), timezoneOffsetMs), ...(old || {}) };
    state.batches = Array.isArray(state.batches) ? state.batches : [];
    state.records = Array.isArray(state.records) ? state.records : [];
    // One-time migration from the former single-principal representation.
    if (!state.batches.length && BigInt(state.principalUnits || '0') > 0n) {
      const principal = BigInt(state.principalUnits);
      const started = Date.parse(state.startedAt || iso(clock()));
      const p = planFor(state.config?.termDays || 360);
      state.batches.push({ id:id('aib'), wallet:address, principalUnits:principal.toString(), planDays:p.days, rateBps:p.rateBps,
        startedAt:started, expiresAt:started + p.days * DAY_MS, status:state.running ? 'active' : 'redeemed',
        dayStartAt:startOfDay(started, timezoneOffsetMs, dayMs), dayEarnedUnits:state.dayEarnedUnits || '0', totalEarnedUnits:state.totalEarnedUnits || '0', daySlotTarget:slotsPerDay, lastSlotAt:Number(state.lastSlotAt || started) });
    }
    return state;
  }
  function persist(address, state) {
    state.running = state.batches.some(b => b.status === 'active');
    const activePrincipal = state.batches.filter(b => b.status === 'active').reduce((sum,b) => sum + BigInt(b.principalUnits || '0'), 0n);
    state.capitalUnits = activePrincipal.toString();
    state.cashUnits = activePrincipal.toString();
    state.inventoryUnits = '0';
    // 兼容两种入账模式：
    //  - 新代码：每 slot 立即 creditReward，所以 totalEarnedUnits 本身就是"已入账奖励累计"，
    //    因此 realizedPnlUnits 与 ai_managed_rewards 表汇总永远一致。平台排行榜不会重复计数
    //    （AI 托管条目从 strategyUnits 排除）。
    //  - 老代码：只有 target 达标才一次性 creditReward；这里仍以 totalEarnedUnits 为准，
    //    排行榜用 pendingEarned 兜底补齐已产生但没落 rewards 表的部分。
    state.realizedPnlUnits = BigInt(state.totalEarnedUnits || '0').toString();
    state.lastPriceUnits = String(state.lastPriceUnits || '0');
    state.badDebtUnits = '0';
    state.updatedAt = iso(clock());
    platformService.updateInternalStrategy(address, AI_MANAGED_KEY, state);
    for (const batch of state.batches) db?.upsertAiBatch?.({ ...batch, wallet:address, status:batch.status });
  }
  function creditReward(address, reward, batch, rewardDate, slotAt) {
    if (reward <= 0n) return;
    // 幂等：同 batch + 同 slotAt 只会入账一次，即使定时器重跑也不重发、不重写。
    const rewardId = `air_${batch.id}_${slotAt}`;
    const already = db?.aiRewardById?.(rewardId);
    if (already) return;
    const slotAtMs = typeof slotAt === 'number' && Number.isFinite(slotAt) ? slotAt : (Number(batch.lastSlotAt) || Date.now());
    walletService.creditBalance?.(address, 'USDT', reward);
    db?.insertAiReward?.({ id:rewardId, batchId:batch.id, wallet:address, amountUnits:reward.toString(), rewardDate, slotAt:slotAtMs, createdAt:slotAtMs, source:'platform' });
    referralService?.distributeAiReward?.(address, reward, batch, slotAtMs);
    // AI 跟单结算收益 → 交易积分（亏损 slot 不入账，天然不送分；rewardId 幂等防重发）
    pointsService?.onCopyProfit?.(address, reward, rewardId, slotAtMs);
  }
  function recordSlot(address, batch, t, allCandles) {
    if (batch.status !== 'active' || t >= Number(batch.expiresAt)) return false;
    const day = startOfDay(t - 1, timezoneOffsetMs, dayMs);
    if (day > Number(batch.dayStartAt)) { batch.dayStartAt = day; batch.dayEarnedUnits = '0'; batch.daySlotCount = 0; batch.dayProcessedSlots = 0; batch.daySlotTarget = slotsPerDay; }
    const principal = BigInt(batch.principalUnits);
    const target = principal * BigInt(batch.rateBps) / 10_000n;
    const earned = BigInt(batch.dayEarnedUnits || '0');
    if (earned >= target) return true;
    const remaining = target - earned;
    const slotTarget = Math.max(1, Number(batch.daySlotTarget || slotsPerDay));
    const processedSlots = Math.min(slotTarget, Number(batch.dayProcessedSlots || 0) + 1);
    batch.dayProcessedSlots = processedSlots;
    const slotsLeft = Math.max(0, slotTarget - processedSlots);
    const symbol = seededValue(batch, t, 0x85ebca6b) % 100 < 58 ? 'BTC' : 'ETH';
    const sets = normalizedCandleSets(allCandles);
    const candles = sets[symbol]?.length ? sets[symbol] : sets.BTC?.length ? sets.BTC : sets.ETH || [];
    const candle = candleFor(candles, t);
    const recordSeed = seededValue(batch, t, 0x9e3779b9);
    // K 线数据不可用时（API 失败），用确定性 fallback 价格生成合理记录，避免 price=1 的垃圾数据。
    // fallback 价格基于 symbol + 时间戳做确定性微波动，重启/补算结果一致。
    const FALLBACK = symbol === 'BTC' ? 77000 : 3000;
    const effectiveCandle = candle && Number(candle?.open) > 0
      ? candle
      : { open: FALLBACK, close: FALLBACK * (1 + ((recordSeed % 1001) - 500) / 500_000), time: t };
    // 随机间隔下每日 slot 数不固定：若下一 slot 越过当日边界，则本笔必须收尾，
    // 把当日 remaining 一次补齐，保证日化 target 不因间隔抖动而缺损。
    const nextSlotAt = t + slotIntervalMs(batch, t);
    const mustRecord = slotsLeft === 0 || nextSlotAt >= Number(batch.dayStartAt) + dayMs;
    const variation = 45n + BigInt(recordSeed % 181);
    const expectedRecords = Math.max(1, slotsLeft + 1);
    const average = remaining / BigInt(expectedRecords);
    const variable = average * variation / 100n;
    const reward = mustRecord ? remaining : (variable > 0n && variable < remaining ? variable : average);
    if (reward <= 0n) return false;
    const execution = executionDetails(batch, t, effectiveCandle, reward);
    if (!(execution.size > 0)) return false;
    const executionTime = Number(effectiveCandle?.time || t);
    // 记录真实 PnL（可为负），但 dayEarned/creditReward 仍用计划 reward，保证日化稳定
    const pnlUnits = BigInt(Math.round(execution.pnlValue * 1e6));
    const rec = { id:id('aim'), t, slotAt:t, historicalCandleTime:executionTime, batchId:batch.id, simulated:true, kind:'simulated-grid', symbol:`${symbol}USDT`,
      ...execution, profitUnits:pnlUnits.toString(), profit:Number(formatUnits(pnlUnits, USDT_DECIMALS)), plannedRewardUnits:reward.toString(), source:'platform-kline' };
    stateRecords.push(rec);
    // 结算规则：亏损 slot 只在「跟单明细」里展示（红字负 PnL），不写资产入账流水、不扣余额、
    // 不分佣、不计入收益统计；亏损份额由 remaining 自动分摊给后续盈利 slot。
    // 日终扫尾笔保底入账，保证日化 target 完整。
    if (pnlUnits < 0n && !mustRecord) {
      batch.daySlotCount = Number(batch.daySlotCount || 0) + 1;
      batch.dayProcessedSlots = Math.max(0, Number(batch.dayProcessedSlots || 1) - 1);
      return true;
    }
    const nextEarned = earned + reward;
    batch.dayEarnedUnits = nextEarned.toString(); batch.daySlotCount = Number(batch.daySlotCount || 0) + 1;
    batch.totalEarnedUnits = (BigInt(batch.totalEarnedUnits || '0') + reward).toString();
    // ✅ 结算节奏：收益先累计进 pendingCreditUnits，跨过 8 小时结算窗口（或日终扫尾笔）时
    //    一次性 creditBalance + 写一条 ai_managed_rewards 流水 —— 资产页一天只出现约 3 条结算入账。
    //    幂等：rewardId 绑定结算 slot 的 t，重放/补算不会重复入账。
    batch.pendingCreditUnits = (BigInt(batch.pendingCreditUnits || '0') + reward).toString();
    const creditWindow = Math.floor((t - timezoneOffsetMs) / AI_CREDIT_WINDOW_MS);
    if (mustRecord || creditWindow > Number(batch.lastCreditWindow ?? creditWindow)) {
      const pending = BigInt(batch.pendingCreditUnits || '0');
      if (pending > 0n) creditReward(address, pending, batch, new Date(day).toISOString().slice(0, 10), t);
      batch.pendingCreditUnits = '0';
      batch.lastCreditWindow = creditWindow;
    }
    return true;
  }
  let stateRecords = [];
  async function processAddress(address, now = clock(), candleData = null) {
    const state = read(address); stateRecords = state.records;
    const active = state.batches.filter(b => b.status === 'active'); if (!active.length) return state;
    // Legacy single-principal states are converted in read(); persist their batches
    // before inserting reward rows that reference those batch ids.
    for (const batch of state.batches) db?.upsertAiBatch?.({ ...batch, wallet:address, status:batch.status });
    const candles = normalizedCandleSets(candleData || await candleSets());
    let changed = false;
    for (const batch of active) {
      const principal = BigInt(batch.principalUnits || '0');
      const target = principal * BigInt(batch.rateBps || 0) / 10_000n;
      const earned = BigInt(batch.dayEarnedUnits || '0');
      if (Number(batch.recordCadenceVersion || 0) < 3) {
        // Older batches advanced every 72 minutes but omitted most visible rows.
        // Replay only an unfinished current day; prior rewards stay untouched.
        if (earned < target) {
          const replayStart = Math.max(Number(batch.startedAt || 0), Number(batch.dayStartAt || 0));
          stateRecords = stateRecords.filter(record => record.batchId !== batch.id
            || Number(record.slotAt || record.t || 0) < Number(batch.dayStartAt || 0));
          batch.dayEarnedUnits = '0';
          batch.daySlotCount = 0;
          batch.dayProcessedSlots = 0;
          batch.lastSlotAt = replayStart;
        }
        batch.recordCadenceVersion = 3;
        changed = true;
      }
      // 随机间隔链：下一 slot 时间 = 当前 + slotIntervalMs(batch, cursor)，确定性可重放
      let cursor = Number(batch.lastSlotAt || batch.startedAt);
      for (;;) {
        const next = cursor + slotIntervalMs(batch, cursor);
        if (next > now || next >= Number(batch.expiresAt)) break;
        cursor = next; batch.lastSlotAt = cursor;
        if (recordSlot(address, batch, cursor, candles)) changed = true;
      }
      // 🛟 一次性回填：老代码每 72 分钟 slot 计算 reward 但只把 target 达标当天 creditReward 一次，
      // 导致 ai-managed.totalEarnedUnits(含今日19个slot已记录的收益) 比 ai_managed_rewards 表汇总
      // 多出「今日 pending 228.8 U / 238.66 U 」。这里用 batch 维度 diff 把差额补齐（幂等 id 防重复）。
      if (db?.listAiRewards && BigInt(batch.totalEarnedUnits || '0') > 0n) {
        const rewarded = db.listAiRewards(address, 20000)
          .filter(r => r.batchId === batch.id && r.kind !== 'referral' && r.kind !== 'loss' && r.kind !== 'start' && r.kind !== 'redeem' && r.kind !== 'adjust')
          .reduce((s, r) => s + BigInt(r.amountUnits || '0'), 0n);
        // gap 需扣掉尚未到结算窗口的 pendingCredit，否则窗口结算 + catchup 会重复入账
        const gap = BigInt(batch.totalEarnedUnits || '0') - BigInt(batch.pendingCreditUnits || '0') - rewarded;
        if (gap > 0n) {
          const rewardDate = new Date(Number(batch.dayStartAt || batch.lastSlotAt || now)).toISOString().slice(0, 10);
          // 幂等 id 带 _catchup_ 前缀 + dayStartAt；重跑不会二次 credit。
          creditReward(address, gap, batch, rewardDate, `${batch.id}_catchup_${Number(batch.dayStartAt) || 'now'}`);
          changed = true;
        }
      }
      // 本金闭环：新托管 batch (batch.ledger='wallet' — start 扣了 wallet) 在到期/赎回时才返还；
      // 老 batch (ledger 空) 自始至终 wallet 没扣款，所以**绝对不能再次 creditBalance 本金**，
      // 否则会平白把 platform 的担保金 2 次发放到用户余额（历史 bug 根因）。
      if (now >= Number(batch.expiresAt)) {
        // 到期日按实际存活时长比例补发当日收益：slot 链在 expiresAt 处中断
        //（循环 next>=expiresAt 即 break），日终扫尾笔永远不会执行，
        // 不补则到期日会少发约半天的日化收益；同时把未跨 8 小时窗口的 pending 一并结算。
        const expiryMs = Number(batch.expiresAt);
        const dayStartMs = Math.max(Number(batch.dayStartAt || 0), expiryMs - dayMs);
        const elapsedMs = Math.max(0, Math.min(dayMs, expiryMs - dayStartMs));
        const proratedTarget = BigInt(batch.principalUnits || '0') * BigInt(batch.rateBps || 0) * BigInt(elapsedMs) / 10_000n / BigInt(dayMs);
        const expiryGap = proratedTarget - BigInt(batch.dayEarnedUnits || '0');
        const pendingAtExpiry = BigInt(batch.pendingCreditUnits || '0');
        const payAtExpiry = (expiryGap > 0n ? expiryGap : 0n) + pendingAtExpiry;
        if (payAtExpiry > 0n) {
          if (expiryGap > 0n) {
            batch.dayEarnedUnits = (BigInt(batch.dayEarnedUnits || '0') + expiryGap).toString();
            batch.totalEarnedUnits = (BigInt(batch.totalEarnedUnits || '0') + expiryGap).toString();
          }
          const rewardDate = new Date(dayStartMs).toISOString().slice(0, 10);
          // 幂等 id 绑定 expiresAt：正常 slot 的 t 恒 < expiresAt，无碰撞；重放不重发
          creditReward(address, payAtExpiry, batch, rewardDate, expiryMs);
          batch.pendingCreditUnits = '0';
          changed = true;
        }
        batch.status = 'expired';
        batch.lastSlotAt = expiryMs;
        if (batch.ledger === 'wallet') walletService.creditBalance?.(address, 'USDT', BigInt(batch.principalUnits));
        changed = true;
      }
    }
    state.records = stateRecords.slice(-MAX_RECORDS); state.totalEarnedUnits = state.batches.reduce((s,b) => s + BigInt(b.totalEarnedUnits || '0'), 0n).toString();
    if (changed) persist(address, state);
    return state;
  }
  // 跟单权益：销毁 1000 AIX 开通 30 天，到期失效后再次开启需重新销毁
  function unlockInfo(state, now = clock()) {
    const unlockedAt = Number(state.copyTradeUnlockedAt || 0);
    if (!unlockedAt) return { active:false, unlockedAt:0, expiresAt:0, daysLeft:0 };
    const expiresAt = unlockedAt + COPY_TRADE_UNLOCK_DAYS * DAY_MS;
    const active = now < expiresAt;
    const daysLeft = active ? Math.max(0, Math.ceil((expiresAt - now) / DAY_MS)) : 0;
    return { active, unlockedAt, expiresAt, daysLeft };
  }
  function present(state, address) {
    const active = state.batches.filter(b => b.status === 'active');
    const principal = active.reduce((s,b) => s + BigInt(b.principalUnits || '0'), 0n);
    const earned = active.reduce((s,b) => s + BigInt(b.dayEarnedUnits || '0'), 0n);
    const target = active.reduce((s,b) => s + BigInt(b.principalUnits || '0') * BigInt(b.rateBps || 0) / 10_000n, 0n);
    const batchesById = new Map(state.batches.map(batch => [batch.id, batch]));
    const records = state.records.slice(-200).reverse().map(record => {
      const openPrice = Number(record.openPrice || record.price || 0), closePrice = Number(record.closePrice || record.price || 0);
      const profit = Number(record.profit || formatUnits(BigInt(record.profitUnits || '0'), USDT_DECIMALS));
      const actualPnl = Math.abs(closePrice - openPrice) * Number(record.size || 0);
      const batch = batchesById.get(record.batchId) || { principalUnits:principal.toString() };
      const leverage = Number(record.leverage || 0);
      // 基础合法性检查（缺价格/零仓位/非法杠杆/价格=1 fallback 残留 才重算）
      const basicInvalid = !(openPrice > 0) || !(closePrice > 0) || !(Number(record.size) > 0) || leverage < 3 || leverage > 10 || openPrice <= 1;
      const pnlMismatch = record.pnlValue === undefined || Math.abs(actualPnl - Math.abs(profit)) > Math.max(0.000001, Math.abs(profit) * 0.001);
      if (!basicInvalid && !pnlMismatch) return record;
      // 重算：用记录自有的 open/close 价格 + 计划 reward 做仓位锚定，产出真实 PnL（可为负）
      const reward = BigInt(record.plannedRewardUnits || record.profitUnits || parseUnits(String(profit || 0), USDT_DECIMALS));
      // 价格=1 的垃圾记录（K线 API 失败时产生）→ 用确定性 fallback 价格重算
      const sym = String(record.symbol || '').replace('USDT', '');
      const fb = sym === 'ETH' ? 3000 : 77000;
      const rs = Math.abs(Math.trunc(Number(record.t || 0) / Math.max(1, slotMs) + fb));
      const safeOpen = openPrice > 1 ? openPrice : fb;
      const safeClose = closePrice > 1 ? closePrice : fb * (1 + ((rs % 1001) - 500) / 500_000);
      const recomputed = executionDetails(batch, Number(record.t), { open:safeOpen, close:safeClose, price:safeClose }, reward, record.direction);
      const pnlUnits = BigInt(Math.round(recomputed.pnlValue * 1e6));
      return { ...record, ...recomputed, profitUnits:pnlUnits.toString(), profit:Number(formatUnits(pnlUnits, USDT_DECIMALS)), plannedRewardUnits:reward.toString() };
    });
    const unlock = unlockInfo(state);
    return { running:active.length > 0, autoCompound:false,
      copyTradeUnlocked: unlock.active, unlockDaysLeft: unlock.daysLeft,
      unlockExpiresAt: unlock.expiresAt ? iso(unlock.expiresAt) : null,
      unlockCostA: formatUnits(COPY_TRADE_UNLOCK_A, A_TOKEN_DECIMALS), unlockDays: COPY_TRADE_UNLOCK_DAYS,
      monthlyRate:active[0] ? Number(active[0].monthlyPct || 22) : 22, dailyRate:active[0] ? Number(active[0].rateBps) / 10000 : 0,
      principal:formatUnits(principal, USDT_DECIMALS), managedBalance:formatUnits(principal + earned, USDT_DECIMALS), dayEarned:formatUnits(earned, USDT_DECIMALS),
      dayTarget:formatUnits(target, USDT_DECIMALS), totalEarned:formatUnits(BigInt(state.totalEarnedUnits || '0'), USDT_DECIMALS), progress:target > 0n ? Number(earned * 1_000_000n / target) / 1_000_000 : 0,
      availableBalance:formatUnits(walletService.balanceUnits(address, 'USDT'), USDT_DECIMALS), batches:state.batches.map(b => ({ ...b, principal:formatUnits(BigInt(b.principalUnits), USDT_DECIMALS), totalEarned:formatUnits(BigInt(b.totalEarnedUnits || '0'), USDT_DECIMALS) })), records };
  }
  async function start(address, value, options = {}) {
    const capital = amount(value, '托管金额'), now = clock(), state = read(address), plan = planFor();
    const dayStartAt = startOfDay(now, timezoneOffsetMs, dayMs);
    const daySlotTarget = Math.max(1, Math.min(slotsPerDay, Math.ceil((dayStartAt + dayMs - now) / slotMs)));
    // 合约跟单采用 VIP 会员制：需先单独「开通 VIP」（销毁 1000 AIX / 30 天），VIP 有效才能跟单；
    // 跟单本身只扣 USDT 本金，不再扣 AIX（AIX 在 unlock() 开通/续费时一次性销毁）。
    // 老用户兼容：上线前已有跟单批次且从未开通的钱包，首次跟单赠送一次 30 天 VIP，不补收。
    const unlock = unlockInfo(state, now);
    const grandfathered = !state.copyTradeUnlockedAt && state.batches.some(b => b.status === 'active' || b.status === 'redeemed' || b.status === 'expired');
    if (!unlock.active && !grandfathered) {
      throw new Error('请先开通 VIP 跟单权益（销毁 1000 枚 AIX / 30 天），开通后即可开始跟单');
    }
    // 新 batch：30 天锁仓（lockUntilAt），无到期日（expiresAt 设 3650 天≈10 年）
    walletService.debitBalance?.(address, 'USDT', capital);
    const copyTradeUnlockedAt = state.copyTradeUnlockedAt || (grandfathered ? now : null); // 老用户赠送一次 30 天 VIP
    const batch = { id:id('aib'), wallet:address, principalUnits:capital.toString(), planDays:plan.days, rateBps:plan.rateBps, monthlyPct:plan.monthlyPct, symbol:String(options.symbol || 'BTC').toUpperCase(), startedAt:now, lockUntilAt:now + AI_MANAGED_LOCK_DAYS * dayMs, expiresAt:now + 3650 * dayMs, status:'active', dayStartAt, dayEarnedUnits:'0', totalEarnedUnits:'0', daySlotCount:0, dayProcessedSlots:0, daySlotTarget, lastSlotAt:now, recordCadenceVersion:3, ledger:'wallet', pendingCreditUnits:'0', lastCreditWindow:Math.floor((now - timezoneOffsetMs) / AI_CREDIT_WINDOW_MS) };
    const nextPrincipal = state.batches.filter(b => b.status === 'active').reduce((sum,b) => sum + BigInt(b.principalUnits || '0'), capital);
    const next = { ...state, running:true, batches:[...state.batches, batch], records:state.records, totalEarnedUnits:state.totalEarnedUnits || '0', startedAt:state.startedAt || iso(now), capitalUnits:nextPrincipal.toString(), cashUnits:nextPrincipal.toString(), inventoryUnits:'0', realizedPnlUnits:state.totalEarnedUnits || '0', lastPriceUnits:state.lastPriceUnits || '0', badDebtUnits:'0', copyTradeUnlockedAt };
    // 本金已在上方 walletService.debitBalance 扣过（wallet-ledger）。策略层只做状态簿记
    // （capitalUnits 供排行榜 ROI 分母 / internalStrategyAccounts 枚举），
    // 用 updateInternalStrategy（不碰余额）；startInternalStrategy/addToInternalStrategy 会再扣一次本金，禁用。
    if (platformService.updateInternalStrategy) platformService.updateInternalStrategy(address, AI_MANAGED_KEY, next);
    else if (state.running && platformService.addToInternalStrategy) platformService.addToInternalStrategy(address, AI_MANAGED_KEY, next, capital);
    else platformService.startInternalStrategy(address, AI_MANAGED_KEY, next, capital);
    db?.upsertAiBatch?.(batch);
    // 先存 batch 再写流水，避免外键约束失败
    const startId = `air_start_${batch.id}`;
    if (!db.aiRewardById(startId)) db.insertAiReward({ id:startId, batchId:batch.id, wallet:address, amountUnits:(-capital).toString(), rewardDate:new Date(now).toISOString().slice(0, 10), slotAt:now, createdAt:now, source:'platform', kind:'start' });
    return present(read(address), address);
  }
  // 开通 / 续费 VIP 跟单权益：销毁 1000 枚 AIX = 30 天权益。跟单（start）不再扣 AIX。
  async function unlock(address) {
    if (!aTokenService) throw new Error('跟单 VIP 服务未启用');
    const now = clock();
    const state = read(address);
    const info = unlockInfo(state, now);
    if (info.active) throw new Error(`VIP 跟单权益有效中（剩余 ${info.daysLeft} 天），到期后再续费即可`);
    const isRenew = Boolean(state.copyTradeUnlockedAt);
    const aBalance = BigInt(aTokenService.balanceA(address) || 0n);
    if (aBalance < COPY_TRADE_UNLOCK_A) {
      throw new Error(`${isRenew ? '续费' : '开通'} VIP 跟单权益需销毁 1000 枚 AIX（${COPY_TRADE_UNLOCK_DAYS} 天权益），当前 AIX 余额不足（持有 ${formatUnits(aBalance, A_TOKEN_DECIMALS)} 枚）`);
    }
    walletService.debitBalance?.(address, 'A', COPY_TRADE_UNLOCK_A);
    // VIP 开通/续费固定销毁 1000 枚（不受销毁开关影响）
    aTokenService.burn(COPY_TRADE_UNLOCK_A, 'copy_trade', `${isRenew ? '续费' : '开通'} VIP 跟单权益销毁 1000 枚`);
    state.copyTradeUnlockedAt = now;
    persist(address, state);
    console.log(`[AI托管] ${address} ${isRenew ? '续费' : '开通'} VIP 跟单权益，有效期至 ${iso(now + COPY_TRADE_UNLOCK_DAYS * DAY_MS)}`);
    return present(read(address), address);
  }
  async function redeem(address) {
    const state = await processAddress(address), now = clock(); let returned = 0n;
    for (const batch of state.batches.filter(b => b.status === 'active')) {
      const principal = BigInt(batch.principalUnits);
      // VIP 跟单随进随出：开通 VIP 后随时可赎回，本金全额返还，不扣除任何罚金。
      const penalty = 0n;
      const net = batch.ledger === 'wallet' ? (principal - penalty) : 0n;
      if (net > 0n) {
        walletService.creditBalance(address, 'USDT', net);
        const redeemId = `air_redeem_${batch.id}_${now}`;
        if (!db.aiRewardById(redeemId)) db.insertAiReward({ id:redeemId, batchId:batch.id, wallet:address, amountUnits:net.toString(), rewardDate:new Date(now).toISOString().slice(0, 10), slotAt:now, createdAt:now, source:'platform', kind:'redeem' });
      }
      console.log(`[AI托管] 赎回 batch ${batch.id}: 本金 ${formatUnits(principal, USDT_DECIMALS)} USDT, 随进随出全额返还, 返还 ${formatUnits(net, USDT_DECIMALS)} USDT`);
      returned += net;
      batch.status = 'redeemed';
      batch.redeemedAt = now;
      batch.penaltyUnits = penalty.toString();
    }
    if (returned > 0n) console.log(`[AI托管] ${address} 赎回完成，共返还 ${formatUnits(returned, USDT_DECIMALS)} USDT`);
    persist(address, state); return present(state, address);
  }
  async function stateFor(address) { return present(await processAddress(address), address); }
  async function processAll() { if (processing) return processing; processing = (async () => {
    const primary = platformService.internalStrategyAccounts();
    const dbExtra = (db?.listAiManagedActiveWallets ? db.listAiManagedActiveWallets() : []).map(String);
    const addresses = Array.from(new Set([...primary.map(String), ...dbExtra.map(String)]));
    const candles = await candleSets();
    for (const address of addresses) await processAddress(address, clock(), candles);
  })().finally(() => { processing = null; }); return processing; }
  // 🛟 一次性迁移：处理 catchup 回填误发的 _catchup_ 正向流水（≈本金，如 1000 USDT）。
  // 根因链：① 旧 catchup 过滤没排除 start(-本金)/redeem(+本金)，wallet-ledger 批次首次 tick 时
  // gap≈本金，被 creditReward 误发成一笔 id 含 _catchup_ 的「收益」，污染资产页收益列表和排行榜 ROI；
  // ② 同期 start() 存在双扣（ai-managed 扣一次 + startInternalStrategy 再扣一次），这笔误发
  // 恰好把多扣的本金退回用户余额——所以资金面上用户并未受损（赎回时本金仍正常再返还一次，全周期守恒），
  // 问题仅在「这笔钱被当成收益」。
  // 因此迁移不删流水、不扣余额，只把误发行重标记为 kind:'adjust'（本金冲正），
  // 所有收益口径（catchup 回填 / 资产页跟单收益 / 排行榜）一律排除 adjust。
  function migrateFalsePrincipalCatchup() {
    const MIGRATION_VERSION = 2026090901;
    if (!db?.listAiBatches || !db?.listAiRewards || !db?.updateAiRewardKind) return;
    if (db.hasSchemaMigration?.(MIGRATION_VERSION)) return;
    try {
      let touchedBatches = 0, relabeledRows = 0;
      for (const batch of db.listAiBatches()) {
        const wallet = String(batch.wallet || '');
        if (!wallet || !batch.id) continue;
        const rewards = db.listAiRewards(wallet, 5000).filter(r => r && r.batchId === batch.id);
        // 仅 wallet-ledger 批次（有 kind:'start' 本金扣款流水）受影响
        if (!rewards.some(r => r.kind === 'start')) continue;
        const fakes = rewards.filter(r =>
          !r.kind && BigInt(r.amountUnits || '0') > 0n && typeof r.id === 'string' && r.id.includes('_catchup_'));
        if (!fakes.length) continue;
        for (const r of fakes) { db.updateAiRewardKind(r.id, 'adjust'); relabeledRows++; }
        touchedBatches++;
        const amt = fakes.reduce((s, r) => s + BigInt(r.amountUnits || '0'), 0n);
        console.log(`[AI托管迁移] 批次 ${batch.id.slice(-8)}：${fakes.length} 条误发流水（${formatUnits(amt, USDT_DECIMALS)} USDT）重标记为 adjust 本金冲正，余额不变`);
      }
      db.recordSchemaMigration?.(MIGRATION_VERSION);
      console.log(`[AI托管迁移] 完成：${relabeledRows} 条误发流水重标记（涉及 ${touchedBatches} 个批次），本金双扣源已在代码层修复`);
    } catch (error) {
      console.error('[AI托管迁移] 失败（不阻断启动，下次重启重试）:', error?.message || error);
    }
  }
  migrateFalsePrincipalCatchup();
  const timer = setInterval(() => processAll().catch(error => console.error('[AI 托管]', error?.message || error)), 60_000); timer.unref?.();
  let pointsService = null;
  function setPointsService(service) { pointsService = service || null; }
  return { processAll, redeem, start, unlock, stateFor, setPointsService, stop:() => clearInterval(timer) };
}
