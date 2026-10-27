// K线直线段重画修复（2026-10-21）：中途把每日涨幅改成 5% 后，旧锚点 + 新目标
// 使路径输出与现价差 4%+，tick 被 ±0.3% 限幅顶格 → 匀速直线拉升。
// 本脚本：①把直线段 1m K 线重画为自然波浪（起止价、成交量不变）
//        ②由 1m 重聚合受影响的 5m/15m/1h/4h/1d
//        ③修正 daily 锚点为「今日已完成」（target≈现价，今晚横盘，明 00:00 自动重锚）
// 用法: node fix-kline-20261021.mjs           预览（不写库）
//       node fix-kline-20261021.mjs --apply   执行写库（需先 systemctl stop wg-platform）
import { openDatabase } from './src/database.js';

const APPLY = process.argv.includes('--apply');
const db = openDatabase('/var/lib/wg-platform');
const fmt = t => new Date(t * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

// ── 以下工具与 src/a-token-kline-service.js 逐行一致 ──
const PERIOD_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function periodStart(timeS, period) {
  const sec = PERIOD_SECONDS[period] || 60;
  return Math.floor(Number(timeS) / sec) * sec;
}
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rand) {
  const u = Math.max(1e-9, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function akimaPath(keypoints) {
  const kps = keypoints.slice().sort((a, b) => a.u - b.u);
  if (kps.length === 0) return () => 0;
  if (kps.length === 1) { const v = kps[0].v; return () => v; }
  const n = kps.length - 1;
  const ext = [
    { u: kps[0].u - (kps[1].u - kps[0].u), v: 2 * kps[0].v - kps[1].v },
    ...kps,
    { u: kps[n].u + (kps[n].u - kps[n - 1].u), v: 2 * kps[n].v - kps[n - 1].v },
  ];
  const dx = i => ext[i + 1].u - ext[i].u;
  const m = i => (ext[i + 1].v - ext[i].v) / Math.max(1e-12, dx(i));
  const slopes = [];
  for (let i = 0; i < ext.length - 1; i++) slopes.push(m(i));
  const tan = [];
  for (let i = 1; i < ext.length - 1; i++) {
    const si = i - 1;
    const slopeCount = slopes.length;
    const safe = idx => {
      if (idx >= 0 && idx < slopeCount) return slopes[idx];
      if (slopeCount < 2) return 0;
      if (idx < 0) return 2 * slopes[0] - slopes[1];
      return 2 * slopes[slopeCount - 1] - slopes[slopeCount - 2];
    };
    const s0 = safe(si - 1), s1 = safe(si), s2 = safe(si + 1), s3 = safe(si + 2);
    const w1 = Math.abs(s3 - s2);
    const w2 = Math.abs(s1 - s0);
    const wsum = w1 + w2;
    tan.push(wsum < 1e-12 ? (s1 + s2) / 2 : (w1 * s1 + w2 * s2) / wsum);
  }
  return u => {
    const x = clamp(Number(u), kps[0].u, kps[n].u);
    let i = 0;
    for (let k = 0; k < n; k++) if (x <= kps[k + 1].u) { i = k; break; } else i = n - 1;
    const x0 = kps[i].u, x1 = kps[i + 1].u;
    const y0 = kps[i].v, y1 = kps[i + 1].v;
    const dxv = Math.max(1e-12, x1 - x0);
    const t = (x - x0) / dxv;
    const s0 = tan[i] * dxv;
    const s1 = tan[i + 1] * dxv;
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * y0 + h10 * s0 + h01 * y1 + h11 * s1;
  };
}
function buildKeypoints({ startPrice, targetPrice, volatilityBps = 6, seed = 1 }) {
  const rand = mulberry32((seed * 2654435761) >>> 0);
  const segs = 6;
  const span = targetPrice - startPrice;
  const baseWav = Math.abs(span) / segs * 0.25 + Math.abs(startPrice) * volatilityBps / 10_000;
  const kps = [];
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const smooth = 0.5 - 0.5 * Math.cos(Math.PI * u);
    const wob = Math.sin(u * Math.PI * 2 + rand() * 0.9) * baseWav;
    let v = startPrice + span * smooth + wob;
    if (i === 0) v = startPrice;
    if (i === segs) v = targetPrice;
    kps.push({ u, v: Math.max(0.0001, +(+v.toFixed(8))) });
  }
  return kps;
}
function aggregateMinutes(minuteBars, period, nowS) {
  const dayFloor = periodStart(nowS, '1d');
  const groups = new Map();
  for (const b of minuteBars) {
    const bucket = periodStart(b.time, period);
    if (period === '1d' && bucket < dayFloor) continue;
    const g = groups.get(bucket);
    if (!g) groups.set(bucket, { period, time: bucket, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    else { g.high = Math.max(g.high, b.high); g.low = Math.min(g.low, b.low); g.close = b.close; g.volume += b.volume; }
  }
  return [...groups.values()].sort((a, b) => a.time - b.time);
}

// ── 1. 读取现状 ──
const nowS = Math.floor(Date.now() / 1000);
const poolMeta = JSON.parse(db.getSetting('a_token_pool_meta') || '{}');
const pEnd = Number(poolMeta.priceUsdt);
if (!(pEnd > 0)) throw new Error('priceUsdt 非法: ' + JSON.stringify(poolMeta.priceUsdt));
const bars = db.listATokenKlines('1m', 5000);
if (bars.length < 30) throw new Error('1m K 线过少: ' + bars.length);
const lastBar = bars[bars.length - 1];
console.log(`当前价=${pEnd}  最后1m bar=${fmt(lastBar.time)} close=${lastBar.close}  1m总数=${bars.length}`);
if (Math.abs(lastBar.close - pEnd) / pEnd > 0.005) console.warn(`⚠ 最后一根 close(${lastBar.close}) 与现价差 >0.5%，以现价为准重画`);

// ── 2. 检测直线拉升段起点：最近 4 小时内最早的「连续 6 分钟每分钟涨 >0.15%」 ──
const climb = i => bars[i].close > bars[i - 1].close * 1.0015;
const scanFrom = Math.max(1, bars.length - 4 * 60);
let j = -1;
for (let k = scanFrom; k + 6 <= bars.length; k++) {
  let ok = true;
  for (let m = 0; m < 6; m++) if (!climb(k + m)) { ok = false; break; }
  if (ok) { j = k; break; }
}
if (j < 0) throw new Error('最近 4 小时未检测到直线拉升段，无需修复');
while (j - 1 >= scanFrom && climb(j - 1)) j--; // 回溯纳入段内仍在升的分钟
const t0 = bars[j].time;
const P0 = bars[j - 1].close;
const tLast = lastBar.time;
const tEnd = tLast + 60;
const pctSpan = pEnd / P0 - 1;
console.log(`检测到直线段: ${fmt(t0)} 起，段前收盘 P0=${P0} → 现价 ${pEnd}，段长 ${((tEnd - t0) / 60).toFixed(1)} 分钟，段涨幅 ${(pctSpan * 100).toFixed(2)}%`);
if (pctSpan < 0.02) throw new Error('段涨幅 <2%，检测结果可疑，中止');
if (tEnd - t0 > 5 * 3600) throw new Error('段长 >5 小时，检测结果可疑，中止');

// ── 3. 生成波浪重画（与 tickLiveBar daily 分支同参） ──
const kps = buildKeypoints({
  startPrice: P0, targetPrice: pEnd,
  volatilityBps: 2,
  seed: (Math.round(t0) ^ Math.round(pEnd * 1e7)) >>> 0,
});
const path = akimaPath(kps);
const pr = s => Math.max(0.0001, path((s - t0) / Math.max(1, tEnd - t0)));
const rand = mulberry32((0xBEEF ^ Math.round(t0)) >>> 0);
const rewritten = [];
let prevClose = P0;
for (let k = j; k < bars.length; k++) {
  const t = bars[k].time;
  const isLast = k === bars.length - 1;
  const close = isLast ? pEnd : Math.max(0.0001, pr(Math.min(t + 60, tEnd)) * (1 + gauss(rand) * 0.0004));
  const open = prevClose;
  const ext = Math.abs(gauss(rand)) * 0.0009 * (open + close) / 2;
  const high = Math.max(open, close) + ext;
  const low = Math.max(0.0001, Math.min(open, close) - ext);
  rewritten.push({
    period: '1m', time: t,
    open: +open.toFixed(8), high: +high.toFixed(8), low: +low.toFixed(8), close: +close.toFixed(8),
    volume: bars[k].volume,
  });
  prevClose = close;
}
// 连续性断言
if (Math.abs(rewritten[0].open - P0) > 1e-8) throw new Error('首根开盘 ≠ 段前收盘');
if (Math.abs(rewritten[rewritten.length - 1].close - pEnd) > 1e-7) throw new Error('末根收盘 ≠ 现价');
console.log(`重画 ${rewritten.length} 根 1m（首根 O=${rewritten[0].open} ← 段前收盘；末根 C=${rewritten[rewritten.length - 1].close} = 现价）`);
console.log('采样（每4根）:');
for (let i = 0; i < rewritten.length; i += 4) {
  const b = rewritten[i];
  console.log(`  ${fmt(b.time)}  O:${b.open.toFixed(6)} H:${b.high.toFixed(6)} L:${b.low.toFixed(6)} C:${b.close.toFixed(6)}  vol:${b.volume.toFixed(1)}`);
}

// ── 4. 由 1m 重聚合受影响高周期 ──
const merged = [...bars.slice(0, j), ...rewritten];
const PERIODS = ['5m', '15m', '1h', '4h', '1d'];
const plan = [];
for (const period of PERIODS) {
  const aggFloor = period === '1d' ? periodStart(nowS, '1d') : periodStart(t0, period);
  const minutes = merged.filter(b => b.time >= aggFloor);
  const groups = aggregateMinutes(minutes, period, nowS);
  plan.push({ period, aggFloor, groups });
  const g = groups[groups.length - 1];
  console.log(`${period}: 聚合 ${groups.length} 桶（起点 ${fmt(aggFloor)}），当前桶 ${g ? fmt(g.time) + ` O:${g.open.toFixed(6)} H:${g.high.toFixed(6)} L:${g.low.toFixed(6)} C:${g.close.toFixed(6)}` : '无'}`);
}

// ── 5. 修正 daily 锚点为「今日已完成」 ──
const s = JSON.parse(db.getSetting('a_token_kline_settings') || '{}');
const pct = Number(s.dailyChangePct ?? 1);
const st = s.daily || {};
let anchorNote = '';
let fixedAnchor = null;
if (st && Number(st.endTimeS) > nowS) {
  fixedAnchor = { dayKey: st.dayKey, startTimeS: st.startTimeS, endTimeS: st.endTimeS, startPrice: pEnd / (1 + pct / 100) };
  const target = fixedAnchor.startPrice * (1 + pct / 100);
  if (Math.abs(target - pEnd) / pEnd > 1e-6) throw new Error('锚点目标 ≠ 现价，数学错误');
  console.log(`daily 锚点: startPrice ${st.startPrice} → ${fixedAnchor.startPrice}（target=${target} ≈ 现价；今晚横盘，明 00:00 自动重锚）`);
} else {
  anchorNote = '（当前锚点已过期/缺失，服务重启后会自动重锚，无需修正）';
  console.log('daily 锚点已过期或缺失，跳过修正' + anchorNote);
}

// ── 6. 写库 ──
if (!APPLY) { console.log('\n[预览模式] 未写库。加 --apply 执行（先 systemctl stop wg-platform）。'); process.exit(0); }
const runAll = () => {
  for (const b of rewritten) db.upsertATokenKlineRow(b);
  const del = db.db.prepare('DELETE FROM a_token_klines WHERE period=? AND time>=?');
  for (const { period, aggFloor, groups } of plan) {
    del.run(period, aggFloor);
    for (const g of groups) db.upsertATokenKlineRow(g);
  }
  if (fixedAnchor) db.saveSetting('a_token_kline_settings', JSON.stringify({ ...s, daily: fixedAnchor }));
};
if (typeof db.db.transaction === 'function') db.db.transaction(runAll)();
else runAll();
console.log('\n[已应用] 1m 重画 + 高周期重聚合 + 锚点修正 完成');
