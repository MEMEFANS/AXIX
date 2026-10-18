// 空投积分服务：独立于抽奖积分的空投资格凭证（Hyperliquid Points 模式）。
// 核心对齐 Hyperliquid 的三点：
//  1) 周结算：成交实时只累计「周有效成交量」，每周一 00:00(UTC+8) 后结算上周积分
//  2) 有效量计分：周积分 = 有效成交量 ÷ 单位值（单位值集中配置，可逐周调整，早期参考 $1,000=1 分）
//  3) 无日上限：防刷靠 wash 过滤——同钱包同币种窗口内反向成交视为对倒，双向剔除（双向量都不计分）
// AI 跟单：周结算收益，每 10 USDT 结算收益 = 1 积分（亏损不送分）。
// 积分纯凭证：不可消费、不可转让、不能用于抽奖；流水带周标识供空投快照审计。
import crypto from 'node:crypto';

const USDT_UNITS = 1_000_000n; // 6 位小数
const RULES = {
  trade_unit_usdt: 1000,        // 每 1,000 USDT 有效成交量 = 1 积分（参考 Hyperliquid 早期 $500–1,000/分，可逐周调整）
  copy_profit_per_points: 10,   // 每 10 USDT 跟单结算收益 = 1 积分
  wash_window_ms: 120_000,      // 对倒判定窗口：120 秒内同币种反向成交视为刷量
};

function key(addr) { return String(addr || '').toLowerCase(); }

export function createAirdropPointsService({ database, clock = () => Date.now() }) {
  const db = database;
  const id = (p) => `${p}_${crypto.randomBytes(10).toString('hex')}`;
  const WEEK_RE = /^(air_(?:vol|wash)_(.+)_)(spot|perp|copy)_(\d{4}-\d{2}-\d{2})$/;

  // 周标识：该日所在周的周一日期（UTC+8），如 '2026-10-05'
  function weekOf(t) {
    const d = new Date(Number(t || clock()) + 8 * 3600_000);
    const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - (day - 1) * 86_400_000;
    const m = new Date(monday);
    return `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}-${String(m.getUTCDate()).padStart(2, '0')}`;
  }
  function weekEndTs(week) {
    return Date.parse(`${week}T23:59:59.999Z`) + 8 * 3600_000; // UTC+8 周日末尾
  }
  // 周计数器（settings 表）：air_vol_{wallet}_{type}_{week} / air_wash_...
  function counterKey(prefix, wallet, type, week) { return `air_${prefix}_${key(wallet)}_${type}_${week}`; }
  function readCounter(k) { try { return BigInt(db.getSetting(k) || '0'); } catch { return 0n; } }
  function writeCounter(k, units) { try { db.saveSetting(k, units.toString()); } catch {} }
  function bumpCounter(prefix, wallet, type, week, deltaUnits) {
    const k = counterKey(prefix, wallet, type, week);
    writeCounter(k, readCounter(k) + deltaUnits);
  }

  function ensureAccount(wallet) {
    const w = key(wallet);
    let acc = db.getAirdropAccount(w);
    if (!acc) {
      acc = { wallet: w, points: 0, updatedAt: clock() };
      db.upsertAirdropAccount(acc);
    }
    return acc;
  }
  function getPoints(wallet) { return ensureAccount(wallet).points; }

  // 发放积分（points 仅能为正；流水带周标识）
  function addPoints(wallet, points, type, refId = '', note = '', ts = clock(), week = weekOf(ts)) {
    if (!(points > 0)) return null;
    const w = key(wallet);
    const acc = ensureAccount(w);
    acc.points += points;
    acc.updatedAt = clock();
    db.upsertAirdropAccount(acc);
    const flow = {
      id: id('apf'), wallet: w, change: points, balance: acc.points,
      type, refId, week, note, createdAt: clock(),
    };
    db.insertAirdropFlow(flow);
    return flow;
  }

  // 记录一笔成交对周有效量的贡献；wash 命中时双向剔除
  // ctx: { refId, ts, washMatch: { refId, notionalUnits, ts } | null }
  function onTradingFill(wallet, product, notionalUnitsStr, ctx = {}) {
    try {
      const type = product === 'perp' ? 'perp' : 'spot';
      const w = key(wallet);
      const ts = Number(ctx.ts) || clock();
      const week = weekOf(ts);
      const add = BigInt(String(notionalUnitsStr || '0'));
      // 对倒剔除：本笔不计分，并把对手笔已计入的有效量扣回（双向都不算有效量）
      if (ctx.washMatch) {
        const m = ctx.washMatch;
        const mWeek = weekOf(Number(m.ts) || ts);
        const settledKey = `air_settled_${w}_${type}_${mWeek}`;
        if (mWeek === week || !db.getSetting(settledKey)) {
          bumpCounter('vol', w, type, mWeek, -BigInt(String(m.notionalUnits || '0')));
        }
        bumpCounter('wash', w, type, week, add);
        bumpCounter('wash', w, type, mWeek, BigInt(String(m.notionalUnits || '0')));
        db.insertAirdropFlow({
          id: id('apf'), wallet: w, change: 0, balance: getPoints(w),
          type: 'wash_filtered', refId: `${m.refId}|${String(ctx.refId || '')}`, week,
          note: `对倒剔除：${product === 'perp' ? '合约' : '现货'}双向成交量不计有效量`, createdAt: clock(),
        });
        return null;
      }
      if (add <= 0n) return null;
      bumpCounter('vol', w, type, week, add);
      return null;
    } catch (e) { console.warn('[空投积分] 成交记账失败:', e?.message || e); return null; }
  }

  // 跟单结算收益累计（亏损不累计）
  function onCopyProfit(wallet, profitUnitsStr, refId = '', ts = Date.now()) {
    try {
      const add = BigInt(String(profitUnitsStr || '0'));
      if (add <= 0n) return null;
      bumpCounter('vol', wallet, 'copy', weekOf(ts), add);
      return null;
    } catch (e) { console.warn('[空投积分] 跟单收益记账失败:', e?.message || e); return null; }
  }

  // 结算某钱包某周：周积分 = 有效量 ÷ 单位值（copy 按 10U=1 分）
  function settleWeek(wallet, type, week) {
    const w = key(wallet);
    const settledKey = `air_settled_${w}_${type}_${week}`;
    if (db.getSetting(settledKey)) return null;
    const vol = readCounter(counterKey('vol', w, type, week));
    const perUnits = type === 'copy'
      ? BigInt(Math.round(Number(RULES.copy_profit_per_points) * 1_000_000))
      : BigInt(Math.round(Number(RULES.trade_unit_usdt) * 1_000_000));
    const pts = Number(vol / perUnits);
    let flow = null;
    if (pts > 0) {
      const label = type === 'copy' ? 'AI 跟单' : type === 'perp' ? '合约' : '现货';
      const amount = Number(vol) / 1e6;
      const note = type === 'copy'
        ? `第 ${week} 周：AI 跟单结算收益 ${amount.toFixed(2)} USDT → ${pts} 积分`
        : `第 ${week} 周：${label}有效成交量 ${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT ÷ ${RULES.trade_unit_usdt.toLocaleString()} = ${pts} 积分`;
      flow = addPoints(w, pts, `${type}_trade`, `settle:${type}:${week}`, note, weekEndTs(week), week);
    }
    db.saveSetting(settledKey, '1');
    // 清理本周计数器（wash 留审计 90 天不必删，vol 已结转可删）
    db.deleteSetting(counterKey('vol', w, type, week));
    return flow;
  }
  // 懒结算：用户查看时先把自己的历史周结掉
  function settleWalletDue(wallet) {
    const w = key(wallet);
    const curWeek = weekOf(clock());
    for (const prefix of ['air_vol_', 'air_wash_']) {
      for (const row of db.listSettingsByPrefix(prefix)) {
        const m = String(row.k || '').match(WEEK_RE);
        if (!m || m[2] !== w) continue;
        const [, , , type, week] = m;
        if (week !== curWeek) settleWeek(w, type, week);
      }
    }
  }
  // 全量结算（定时任务 + 启动补算）：结掉所有历史周
  function settleDue() {
    const curWeek = weekOf(clock());
    const wallets = new Map();
    for (const row of db.listSettingsByPrefix('air_vol_')) {
      const m = String(row.k || '').match(WEEK_RE);
      if (!m) continue;
      const [, , wallet, type, week] = m;
      if (week === curWeek) continue;
      const list = wallets.get(week) || [];
      list.push([wallet, type]);
      wallets.set(week, list);
    }
    let settled = 0;
    for (const [week, list] of wallets) {
      for (const [wallet, type] of list) {
        if (settleWeek(wallet, type, week)) settled += 1;
      }
    }
    return { settled };
  }

  function listFlows(wallet, limit = 50) {
    return db.listAirdropFlows(key(wallet), limit);
  }
  // 概览：已结算总分 + 本周进行中（有效量/被剔除量/预估积分）
  function summary(wallet) {
    const w = key(wallet);
    settleWalletDue(w);
    const now = clock();
    const week = weekOf(now);
    const prevWeek = weekOf(Date.parse(`${week}T00:00:00Z`) - 86_400_000);
    const vol = {};
    const wash = {};
    for (const type of ['spot', 'perp', 'copy']) {
      vol[type] = Number(readCounter(counterKey('vol', w, type, week)));
      wash[type] = Number(readCounter(counterKey('wash', w, type, week)));
    }
    const estSpot = Number(BigInt(vol.spot) / BigInt(Math.round(Number(RULES.trade_unit_usdt) * 1e6)));
    const estPerp = Number(BigInt(vol.perp) / BigInt(Math.round(Number(RULES.trade_unit_usdt) * 1e6)));
    const estCopy = Number(BigInt(vol.copy) / BigInt(Math.round(Number(RULES.copy_profit_per_points) * 1e6)));
    return {
      points: ensureAccount(w).points,
      week, prevWeek,
      currentWeek: {
        spotVolume: vol.spot / 1e6, perpVolume: vol.perp / 1e6, copyProfit: vol.copy / 1e6,
        washVolume: (wash.spot + wash.perp) / 1e6,
        estPoints: estSpot + estPerp + estCopy,
      },
      lastWeekPoints: db.sumAirdropFlowsWeek(w, prevWeek),
      rules: RULES,
      note: '按周结算有效成交量积分，对倒刷量双向剔除；积分仅用于空投，不能抽奖',
    };
  }

  return { getPoints, addPoints, onTradingFill, onCopyProfit, settleDue, settleWalletDue, listFlows, summary, weekOf, rules: RULES };
}
