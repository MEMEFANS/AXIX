// K 线全天重画（2026-10-21 补充修复）：此前只把 22:20 起的直线段改成了波浪，
// 但涨幅仍集中在最后半小时 → 5m/15m/4h/1d 仍呈"横盘一天 + 尾部一根上去"。
// 本脚本把今天（北京 00:00 → 当前）的 1m K 线按 daily 波浪路径整体重画为
// 缓慢爬升（开盘价 → 现价，S 型 6 段波浪），再由 1m 重聚合全部高周期，
// 使各周期都呈"慢慢上去的线"。成交量保留，锚点不动（今晚横盘，明 00:00 自动重锚）。
// 用法: node fix-kline-redraw-day-20261021.mjs           预览（不写库）
//       node fix-kline-redraw-day-20261021.mjs --apply   执行（先 systemctl stop wg-platform）
import { openDatabase } from './src/database.js';

const APPLY = process.argv.includes('--apply');
const db = openDatabase('/var/lib/wg-platform');
const fmt = t => new Date(t * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

// ── 与 src/a-token-kline-service.js 逐行一致 ──
const PERIOD_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function periodStart(timeS, period) { const sec = PERIOD_SECONDS[period] || 60; return Math.floor(Number(timeS) / sec) * sec; }
function shanghaiDayStartSec(nowS) {
  const SHIFT = 8 * 3600 * 1000;
  const shifted = Math.floor((Number(nowS) * 1000 + SHIFT) / 86_400_000) * 86_400_000;
  return Math.floor((shifted - SHIFT) / 1000);
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

// ── 读取 ──
const nowS = Math.floor(Date.now() / 1000);
const dayStart = shanghaiDayStartSec(nowS);
const pEnd = Number(JSON.parse(db.getSetting('a_token_pool_meta') || '{}').priceUsdt);
if (!(pEnd > 0)) throw new Error('priceUsdt 非法');
const bars = db.listATokenKlines('1m', 5000).filter(b => b.time >= dayStart);
if (bars.length < 60) throw new Error('今日 1m K 线不足: ' + bars.length);
if (Math.abs(bars[0].time - dayStart) > 60) throw new Error('首根不是今日开盘: ' + fmt(bars[0].time));
const P0 = bars[0].open;           // 今日开盘 = 昨日收盘
const t0 = bars[0].time;
const tEnd = bars[bars.length - 1].time + 60;
const spanPct = pEnd / P0 - 1;
console.log(`今日 ${fmt(t0)} 开盘 ${P0} → 现价 ${pEnd}（+${(spanPct * 100).toFixed(2)}%），重画 ${bars.length} 根 1m`);
if (!(spanPct > 0.01 && spanPct < 0.3)) throw new Error('涨幅异常，中止');

// ── 波浪路径（与 tickLiveBar daily 分支同参） ──
const kps = buildKeypoints({ startPrice: P0, targetPrice: pEnd, volatilityBps: 2, seed: (Math.round(t0) ^ Math.round(pEnd * 1e7)) >>> 0 });
const path = akimaPath(kps);
const pr = s => Math.max(0.0001, path((s - t0) / Math.max(1, tEnd - t0)));
// 噪声/影线尺度对齐线上 tick（v2 修正）：
//  - OU 惯性噪声（非独立白噪声）：每分钟冲击 0.005%，稳态偏离路径约 ±0.012%，与实时 tick 的 ±0.01% 频带一致
//  - 影线均值 ~0.004%、偶发 ~0.015%：v1 用了 0.04% 噪声 + 0.09% 影线（无惯性），
//    比原生大一个数量级，导致 1m 收盘上蹿下跳 + 长针
const OU_THETA = 0.08;
const OU_SIGMA = 0.00005;
const WICK_K = 0.00005;
const rand = mulberry32((0xDA7 ^ Math.round(t0)) >>> 0);
const rewritten = [];
let prevClose = P0;
let ouNoise = 0;
for (let k = 0; k < bars.length; k++) {
  const t = bars[k].time;
  const isLast = k === bars.length - 1;
  ouNoise = ouNoise * (1 - OU_THETA) + gauss(rand) * OU_SIGMA;
  const close = isLast ? pEnd : Math.max(0.0001, pr(Math.min(t + 60, tEnd)) * (1 + ouNoise));
  const open = prevClose;
  const ext = Math.abs(gauss(rand)) * WICK_K * (open + close) / 2;
  const high = Math.max(open, close) + ext;
  const low = Math.max(0.0001, Math.min(open, close) - ext);
  rewritten.push({
    period: '1m', time: t,
    open: +open.toFixed(8), high: +high.toFixed(8), low: +low.toFixed(8), close: +close.toFixed(8),
    volume: bars[k].volume,
  });
  prevClose = close;
}
if (Math.abs(rewritten[0].open - P0) > 1e-8) throw new Error('首根开盘 ≠ 今日开盘');
if (Math.abs(rewritten[rewritten.length - 1].close - pEnd) > 1e-7) throw new Error('末根收盘 ≠ 现价');
console.log('重画采样（每 2 小时一根）:');
for (let i = 0; i < rewritten.length; i += 120) {
  const b = rewritten[i];
  console.log(`  ${fmt(b.time)}  O:${b.open.toFixed(6)} H:${b.high.toFixed(6)} L:${b.low.toFixed(6)} C:${b.close.toFixed(6)}`);
}
{
  const ranges = rewritten.map(b => (b.high - b.low) / b.close * 100).sort((a, b) => a - b);
  const median = ranges[Math.floor(ranges.length / 2)];
  const max = ranges[ranges.length - 1];
  const flips = rewritten.slice(1).filter((b, i) => (b.close - b.open) * (rewritten[i].close - rewritten[i].open) < 0).length;
  console.log(`影线检查: 1m 全距中位 ${median.toFixed(4)}%、最大 ${max.toFixed(4)}%（v1 约 0.15%/0.6%，应明显缩小）`);
  console.log(`形态检查: 相邻 1m 阴阳交替 ${flips}/${rewritten.length - 1} 根（v1 白噪声下接近 50%，应显著下降）`);
}

// ── 重聚合高周期 ──
const PERIODS = ['5m', '15m', '1h', '4h', '1d'];
const plan = [];
for (const period of PERIODS) {
  const aggFloor = period === '1d' ? periodStart(nowS, '1d') : periodStart(t0, period);
  const minutes = rewritten.filter(b => b.time >= aggFloor);
  const groups = aggregateMinutes(minutes, period, nowS);
  plan.push({ period, aggFloor, groups });
  const g = groups[groups.length - 1];
  console.log(`${period}: ${groups.length} 桶（${fmt(aggFloor)} 起），当前桶 ${g ? fmt(g.time) + ` O:${g.open.toFixed(6)} C:${g.close.toFixed(6)}` : '无'}`);
}
// 各周期逐桶涨跌预览（验证"慢慢上去"）
for (const p of ['15m', '4h']) {
  const { groups } = plan.find(x => x.period === p);
  console.log(`${p} 逐桶收盘:`, groups.map(g => g.close.toFixed(5)).join(' → '));
}

// ── 写库 ──
if (!APPLY) { console.log('\n[预览模式] 未写库。加 --apply 执行（先 systemctl stop wg-platform）。'); process.exit(0); }
const runAll = () => {
  for (const b of rewritten) db.upsertATokenKlineRow(b);
  const del = db.db.prepare('DELETE FROM a_token_klines WHERE period=? AND time>=?');
  for (const { period, aggFloor, groups } of plan) {
    del.run(period, aggFloor);
    for (const g of groups) db.upsertATokenKlineRow(g);
  }
};
if (typeof db.db.transaction === 'function') db.db.transaction(runAll)();
else runAll();
console.log('\n[已应用] 今日 1m 全天波浪重画 + 高周期重聚合 完成');
