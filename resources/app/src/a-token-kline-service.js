// A 币 K 线服务：生成历史种子 K 线、按后台调控模式（涨/跌/震荡/每日定涨）推进实时 K 线、
// 维护调控设置、提供读/写接口。与 aTokenService.setPrice 联动，保证 K 线收盘价 = 当前价格。
const SETTINGS_KEY = 'a_token_kline_settings';
export const PERIOD_SECONDS = Object.freeze({
  '1m': 60,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
});
const ORDERED_PERIODS = ['1m', '5m', '15m', '1h', '4h', '1d'];

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function periodStart(timeS, period) {
  const sec = PERIOD_SECONDS[period] || 60;
  return Math.floor(Number(timeS) / sec) * sec;
}

// Seeded pseudo-random walk: 稳定输出（相同参数→相同种子），避免每次启动K线大变。
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
  // Box–Muller
  const u = Math.max(1e-9, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function defaultSettings() {
  return {
    // sideways: 震荡；up: 慢牛；down: 慢熊；daily: 每日定涨/定跌；manual: 完全后台手动，自动推进不触发
    mode: 'sideways',
    // 波动率放大系数（1 = 基准）。越大 K 线实体/影线越长
    volatility: 1,
    // up/down 模式的每期漂移百分比（例如 1m=0.08%），后台可调控
    driftBpsPer1m: { sideways: 0, up: 0.8, down: -0.8 },
    // daily 模式：每日目标涨跌幅（%），如 1 表示每日 +1%；负数表示下跌。北京时间每日 00:00 自动换日重新锚定
    dailyChangePct: 1,
    // daily 模式当日锚点：{ dayKey(当日00:00秒), startTimeS, endTimeS, startPrice }（内部状态，勿手工改）
    daily: null,
    // 每日随机交易 A 数量基准（用于 volume 生成）
    baseVolumePerDayA: 50_000,
  };
}

// 北京时间（UTC+8）当日 00:00 的秒级时间戳
function shanghaiDayStartSec(nowS) {
  const SHIFT = 8 * 3600 * 1000;
  const shifted = Math.floor((Number(nowS) * 1000 + SHIFT) / 86_400_000) * 86_400_000;
  return Math.floor((shifted - SHIFT) / 1000);
}

function clampDailyPct(v) { return clamp(Number(v ?? 1), -95, 95); }

// 每日模式：获取（或初始化/滚日重置）当日行程锚点。
// 起始价 = 锚定时刻的当前价，目标 = startPrice × (1 + 涨幅%)，平滑推进到达标。
// 剩余时间不足 MIN_RAMP_SEC 时自动延展达标期限（可跨 00:00 完成），
// 避免"深夜设 5% → 剩 2 小时强推"造成的陡峭直线。
const MIN_RAMP_SEC = 6 * 3600; // 最小推进时长 6 小时
function ensureDailySchedule(nowS, curPrice, settings, saveSettingsFn) {
  const ds = shanghaiDayStartSec(nowS);
  const st = settings.daily;
  // 计划未到期则一直沿用（含跨日延展的计划）；到期/缺失才重锚
  if (st && Number(st.startPrice) > 0 && Number(st.endTimeS) > Number(nowS)) return st;
  const fresh = {
    dayKey: ds,
    startTimeS: Math.max(ds, Number(nowS)), // 中途启用时从当下开始规划涨幅
    endTimeS: Math.max(ds + 86_400, Number(nowS) + MIN_RAMP_SEC),
    startPrice: Number(curPrice),
  };
  saveSettingsFn({ daily: fresh });
  return fresh;
}

// ── 平滑路径工具：关键点 → 三次样条 → 按位置查询价格，避免一根直针 ──
// 参考 Experience 1778627：统一入口“关键点→平滑曲线→采样成K线/tick”
// 单调样条（Akima Hermite）：简单稳定、拐点不过冲。支持 endpoints hard-anchor（起点必 = first.key，终点必 = last.key）。
function akimaPath(keypoints /* [{u:0..1, v:number}] sorted by u */) {
  const kps = keypoints.slice().sort((a, b) => a.u - b.u);
  if (kps.length === 0) return () => 0;
  if (kps.length === 1) {
    const v = kps[0].v;
    return () => v;
  }
  const n = kps.length - 1;
  // 端点外插 2 段（含虚拟节点）让首尾段有可用导数
  const ext = [
    { u: kps[0].u - (kps[1].u - kps[0].u), v: 2 * kps[0].v - kps[1].v },
    ...kps,
    { u: kps[n].u + (kps[n].u - kps[n - 1].u), v: 2 * kps[n].v - kps[n - 1].v },
  ];
  const dx = i => ext[i + 1].u - ext[i].u;
  const m = i => (ext[i + 1].v - ext[i].v) / Math.max(1e-12, dx(i));
  const slopes = [];
  for (let i = 0; i < ext.length - 1; i++) slopes.push(m(i));
  // Akima 切线（稳健版）：需要 slope[si-1, si, si+1, si+2]，边界用线性镜像延拓避免 5 点越界。
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
    // Akima 标准 4 斜率权重：t = (|s3−s2|·s1 + |s1−s0|·s2) / (|s3−s2| + |s1−s0|)
    const s0 = safe(si - 1), s1 = safe(si), s2 = safe(si + 1), s3 = safe(si + 2);
    const w1 = Math.abs(s3 - s2);
    const w2 = Math.abs(s1 - s0);
    const wsum = w1 + w2;
    tan.push(wsum < 1e-12 ? (s1 + s2) / 2 : (w1 * s1 + w2 * s2) / wsum);
  }
  // tan.length = n+1，对应原始 kps 的每个节点（索引 0..n 映射到 ext 1..n）
  // 插值函数：u 全局位置，返回 v
  return u => {
    const x = clamp(Number(u), kps[0].u, kps[n].u);
    let i = 0;
    for (let k = 0; k < n; k++) if (x <= kps[k + 1].u) { i = k; break; } else i = n - 1;
    const x0 = kps[i].u, x1 = kps[i + 1].u;
    const y0 = kps[i].v, y1 = kps[i + 1].v;
    const dxv = Math.max(1e-12, x1 - x0);
    const t = (x - x0) / dxv;
    const s0 = tan[i] * dxv;      // 起点在 dxv 归一化坐标系的 Δy
    const s1 = tan[i + 1] * dxv;
    // Hermite basis
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * y0 + h10 * s0 + h01 * y1 + h11 * s1;
  };
}
// 根据模式 + 起止价格生成“今天/本周期平滑路径关键点”：每日目标涨幅分 4~6 段波浪爬升，避免直上。
function buildKeypoints({ startPrice, targetPrice, rampBarsOrDurationHours = 18, volatilityBps = 6, seed = 1 }) {
  const rand = mulberry32((seed * 2654435761) >>> 0);
  const segs = 6; // 分 6 个波浪段
  const span = targetPrice - startPrice;
  const baseWav = Math.abs(span) / segs * 0.25 + Math.abs(startPrice) * volatilityBps / 10_000;
  const kps = [];
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    // S 形主升轨：0.5 − 0.5·cos(π·u)，斜率中段最大，首尾平滑。
    const smooth = 0.5 - 0.5 * Math.cos(Math.PI * u);
    // 叠一个小波浪（sin·baseWav），模拟买盘卖盘博弈，不会一条直线。
    const wob = Math.sin(u * Math.PI * 2 + rand() * 0.9) * baseWav;
    // 首段小回撤、末段拉到 target 略破顶回踩再收，形成自然上影/下影。
    let v = startPrice + span * smooth + wob;
    if (i === 0) v = startPrice;            // 强锚定起点：避免启动瞬间跳
    if (i === segs) v = targetPrice;        // 强锚定终点：EOD/EOR 必须收盘 = target
    kps.push({ u, v: Math.max(0.0001, +(+v.toFixed(8))) });
  }
  return kps;
}
export function createATokenKlineService({ database, aTokenService, clock = () => Date.now(), orderService }) {
  const db = database;

  // ── Settings ──
  function getSettings() {
    const raw = db.db.prepare('SELECT payload_json FROM service_settings WHERE setting_key=?')
      .get(SETTINGS_KEY);
    const s = raw ? JSON.parse(raw.payload_json) : {};
    return { ...defaultSettings(), ...s, driftBpsPer1m: { ...defaultSettings().driftBpsPer1m, ...(s.driftBpsPer1m || {}) } };
  }
  function saveSettings(patch) {
    const cur = getSettings();
    const next = { ...cur, ...patch, driftBpsPer1m: { ...cur.driftBpsPer1m, ...((patch && patch.driftBpsPer1m) || {}) } };
    db.db.prepare(`INSERT INTO service_settings(setting_key,payload_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(setting_key) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
      .run(SETTINGS_KEY, JSON.stringify(next), clock());
    return next;
  }

  // 新开盘语义：只生成「1 分钟」基础序列（北京时间当日 00:00 开盘锚点 → 当前），
  // OU 均值回归保证蜡烛连续（open=上一根 close）且价格围绕基准价窄幅横盘；
  // 5m/15m/1h/4h/1d 一律由 1m 聚合（open=首根、high/low=期间极值、close=末根、volume 求和），
  // 确保切换周期时高低点完全一致，不再出现各周期独立随机、跨度互相矛盾的假 K 线。
  // 日线按 UTC 日界只保留当前这根（北京开盘日当天），北京 00:00–08:00 的分钟不并入昨日 UTC 日线。
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

  // 生成「北京时间当日 00:00 开盘 → 当前」的 1 分钟 OU 横盘序列并写库，返回分钟 bar 数组
  function seedMinuteBars(basePrice, nowS) {
    const settings = getSettings();
    const openS = shanghaiDayStartSec(nowS);
    // OU 参数（低频慢波·极窄横盘）：theta=0.02/分钟，sigma=0.0006%/分钟，
    // 全天带宽约 ±0.009%，几乎贴着 0.1 一条直线带极小起伏；影线系数 0.06
    const theta = 0.02;
    const sigmaK = 0.000006;
    const wickK = 0.06;
    const rand = mulberry32((0xA17 ^ 0x100001b3 ^ (Math.round(basePrice * 1e7) & 0xFFFF)) >>> 0);
    const firstT = periodStart(openS, '1m');
    const endT = periodStart(nowS, '1m');
    const volBase = settings.baseVolumePerDayA / 1440;
    let prevClose = basePrice;
    const minutes = [];
    for (let t = firstT; t <= endT; t += 60) {
      const isCurrent = t === endT;
      const open = prevClose;
      let close;
      if (isCurrent) close = basePrice; // 当前进行中 bar 收于基准价，交给实时 tick 接续
      else {
        const pull = theta * (basePrice - open);
        const shock = gauss(rand) * sigmaK * basePrice;
        close = Math.max(0.0001, +(open + pull + shock).toFixed(8));
      }
      const ext = Math.abs(gauss(rand)) * wickK * sigmaK * basePrice;
      const high = +(Math.max(open, close) + ext).toFixed(8);
      const low = Math.max(0.0001, +(Math.min(open, close) - ext).toFixed(8));
      const volume = Math.max(1, volBase * (0.3 + rand() * 0.9));
      const bar = { period: '1m', time: t, open, high, low, close, volume };
      db.upsertATokenKlineRow(bar);
      minutes.push(bar);
      prevClose = close;
    }
    return minutes;
  }

  // 由 1 分钟序列聚合生成其余周期并写库
  function seedAggregatedPeriods(minutes, nowS) {
    for (const period of ['5m', '15m', '1h', '4h', '1d']) {
      const bars = aggregateMinutes(minutes, period, nowS);
      for (const b of bars) db.upsertATokenKlineRow(b);
    }
  }

  function ensureSeeded() {
    const meta = aTokenService.getPoolMeta();
    let basePrice = Number(meta.priceUsdt);
    if (!(basePrice > 0) || !Number.isFinite(basePrice)) {
      basePrice = 0.1;
      try { aTokenService.setPrice('0.1'); } catch (e) { console.warn('[A币K线] ensureSeeded 重置价格失败', e?.message || e); }
    }
    const nowS = Math.floor(clock() / 1000);
    let seededAny = false;
    let minutes = null;
    if (db.countATokenKlines('1m') === 0) {
      minutes = seedMinuteBars(basePrice, nowS);
      seededAny = true;
    }
    for (const period of ['5m', '15m', '1h', '4h', '1d']) {
      if (db.countATokenKlines(period) > 0) continue;
      if (!minutes) minutes = db.listATokenKlines('1m', 5000);
      const bars = aggregateMinutes(minutes, period, nowS);
      for (const b of bars) db.upsertATokenKlineRow(b);
      seededAny = true;
    }
    return seededAny;
  }

  // 后台「重置K线」：清掉全部蜡烛后，按「当日新开盘」重建——
  // 只生成北京时间当日 00:00 至今的 1m 横盘序列并聚合其它周期，绝不回填过去日期的历史蜡烛。
  function rebuildAll(basePrice) {
    const price = Number(basePrice) > 0 ? Number(basePrice) : Number(aTokenService.getPoolMeta().priceUsdt || 0.1);
    for (const period of ORDERED_PERIODS) db.clearATokenKlines(period);
    // 同步当前价格为最新 close
    aTokenService.setPrice(price.toFixed(8));
    // 当日涨跌幅锚点作废，从新价格重新锚定
    try { saveSettings({ daily: null }); } catch (e) { console.warn('[A币K线] rebuildAll 重置daily锚点失败', e?.message || e); }
    const nowS = Math.floor(clock() / 1000);
    const minutes = seedMinuteBars(price, nowS);
    seedAggregatedPeriods(minutes, nowS);
    // 重建后触发一次撮合，确保 OPEN 订单在新基价下及时处理
    try { orderService?.matchOpenOrders?.(); } catch (e) { console.error('[A币K线] rebuildAll 撮合错误', e?.message || e); }
    return { price, periods: ORDERED_PERIODS };
  }

  // ── 读取 ──
  function listKlines(period, limit = 500) {
    const p = PERIOD_SECONDS[period] ? period : '15m';
    return db.listATokenKlines(p, limit);
  }

  // ── 追加/写入一根人工蜡烛（后台用）。若为各周期当前 bar 则 upsert。
  function appendCandle(period, candle) {
    if (!PERIOD_SECONDS[period]) throw new Error('period 无效');
    const c = {
      time: candle.time || Math.floor(clock() / 1000),
      open: Number(candle.open), high: Number(candle.high),
      low: Number(candle.low), close: Number(candle.close),
      volume: Number(candle.volume || 0),
    };
    if (!(c.close > 0) || !(c.open > 0)) throw new Error('价格必须 > 0');
    c.time = periodStart(c.time, period);
    c.high = Math.max(c.high, c.open, c.close);
    c.low = Math.min(c.low, c.open, c.close);
    db.upsertATokenKlineRow({ period, ...c });
    // 若该 bar 的时间窗包含当前时间 → 同步价格为 close
    const nowS = Math.floor(clock() / 1000);
    if (c.time <= nowS && nowS < c.time + PERIOD_SECONDS[period]) {
      aTokenService.setPrice(c.close.toFixed(8));
    }
    return c;
  }

  // 实时 tick 的微观盘口噪声：AR(1) 惯性过程（不是每跳独立白噪声）。
  // 独立白噪声会让当前 bar 的 high/low 被随机尖刺扫成长上/下影；带惯性后相邻 tick 同向小步移动，影线短而连续。
  let microState = 0;
  function nextMicro(amp) {
    microState = microState * 0.85 + (Math.random() * 2 - 1) * amp;
    return microState;
  }

  // daily 平滑路径内存缓存：fn 不可序列化（此前存库每次 miss，导致每 tick 重建路径 + 多写一次库）
  let dailyPathCache = { key: '', fn: null };

  // ── 实时 tick（由定时任务每 15~30 秒调用一次）：
  // 1. 基于调控模式在 1m 当前 bar 上制造价格微波动；
  // 2. 聚合推进更高周期当前 bar 的 high/low/close；
  // 3. 跨周期边界时，新开一根 bar（open=上一根close）。
  function tickLiveBar() {
    ensureSeeded();
    const settings = getSettings();
    if (settings.mode === 'manual') return { skipped: true, reason: 'manual mode' };
    const nowS = Math.floor(clock() / 1000);

    // 计算一个价格"下一步"：根据当前模式
    const meta = aTokenService.getPoolMeta();
    let curPrice = Number(meta.priceUsdt);
    if (!(curPrice > 0) || !Number.isFinite(curPrice)) {
      console.warn('[A币K线] 当前价格非法，回退 0.1：', JSON.stringify(meta.priceUsdt));
      curPrice = 0.1;
      try { aTokenService.setPrice('0.1'); } catch (e) { console.warn('[A币K线] 回退设价失败', e?.message || e); }
    }
    const std1m = 0.0025 * clamp(settings.volatility || 1, 0.1, 5);
    // 单 tick 硬限幅：避免瞬间针。真实市场 10s 内很少跳超过 0.3%。
    const TICK_MAX_MOVE = 0.003 * clamp(settings.volatility || 1, 0.2, 4); // ±0.3% 基准
    // 计算本 tick 的目标参考价（路径价格）：
    //  (1) daily 模式：取 今日平滑路径（startPrice → EOD target × 6 段波浪 + 小噪声）在 now 的位置
    //  (2) up/down/sideways 模式：取 drift + 短期波动的“平滑路径”（用近 30 分钟为一段做微波浪，避免锯齿针）
    let pathNextPrice = curPrice;
    if (settings.mode === 'daily') {
      const st = ensureDailySchedule(nowS, curPrice, settings, saveSettings);
      const pct = clampDailyPct(settings.dailyChangePct);
      const targetEod = Math.max(0.0001, st.startPrice * (1 + pct / 100));
      const window = Math.max(1, st.endTimeS - st.startTimeS);
      const progress = clamp((nowS - st.startTimeS) / window, 0, 1);
      // 路径缓存放内存（dailyPathCache），锚点改变才重建；fn 不可序列化，勿存库
      const cacheKey = `daily_${st.startTimeS}_${st.endTimeS}_${st.startPrice.toFixed(8)}_${targetEod.toFixed(8)}_${settings.volatility}`;
      let path = dailyPathCache.key === cacheKey ? dailyPathCache.fn : null;
      if (!path) {
        const kps = buildKeypoints({
          startPrice: Number(st.startPrice),
          targetPrice: targetEod,
          volatilityBps: 2 * clamp(settings.volatility || 1, 0.2, 4),
          seed: (Math.round(st.startTimeS) ^ Math.round(targetEod * 1e7)) >>> 0,
        });
        path = akimaPath(kps);
        dailyPathCache = { key: cacheKey, fn: path };
      }
      const smoothPrice = Math.max(0.0001, path(progress));
      // 微观 tick noise：AR(1) 惯性噪声（稳态约 ±0.01%），实时段影线短而连续
      const micro = nextMicro(std1m * 0.025);
      pathNextPrice = Math.max(0.0001, smoothPrice * (1 + micro));
    } else {
      // sideways/up/down：用“短窗口平滑路径”（30 min 为一个周期）避免一根直针或连续跳针
      const drift1mBps = settings.driftBpsPer1m?.[settings.mode] ?? 0;
      const windowSec = 30 * 60;
      const startOfWindow = Math.floor(nowS / windowSec) * windowSec;
      const windowStartPrice = Number(curPrice); // 以当前价为本窗口起点（会漂移，但相邻 tick 同向平滑）
      const windowTarget = Math.max(0.0001, windowStartPrice * (1 + (drift1mBps / 10_000) * (windowSec / 60)));
      const progress = clamp((nowS - startOfWindow) / windowSec, 0, 1);
      const kps = buildKeypoints({
        startPrice: windowStartPrice,
        targetPrice: windowTarget,
        volatilityBps: 3 * clamp(settings.volatility || 1, 0.2, 4),
        seed: (startOfWindow ^ Math.round(windowTarget * 1e7) ^ (drift1mBps * 97)) >>> 0,
      });
      const path = akimaPath(kps);
      const smoothPrice = Math.max(0.0001, path(progress));
      const micro = nextMicro(std1m * 0.025);
      pathNextPrice = Math.max(0.0001, smoothPrice * (1 + micro));
    }
    // 最终 nextPrice = 在「单 tick 限幅」范围内，朝 pathNextPrice 走（让历史方向不突变）
    const loCap = curPrice * (1 - TICK_MAX_MOVE);
    const hiCap = curPrice * (1 + TICK_MAX_MOVE);
    let nextPrice = clamp(pathNextPrice, loCap, hiCap);
    // 保险：任何非有限数 / NaN 都用 curPrice 或 0.1 顶回，不让下游 aTokenService.setPrice 抛错
    if (!Number.isFinite(nextPrice) || !(nextPrice > 0)) {
      console.warn('[A币K线] nextPrice 非法，用 curPrice 顶回:', nextPrice, 'curPrice=', curPrice, 'mode=', settings.mode);
      nextPrice = curPrice && curPrice > 0 ? curPrice : 0.1;
    }

    const volumeTick = Math.max(1,
      (settings.baseVolumePerDayA / 86400) * (10 + Math.random() * 30));

    // 对每个周期更新当前 bar
    for (const period of ORDERED_PERIODS) {
      const sec = PERIOD_SECONDS[period];
      const t = periodStart(nowS, period);
      let bar;
      // 检查是否已有该时间的 bar（从 DB 读最新一条并比较 time）
      const last = db.listATokenKlines(period, 1);
      if (last.length === 0 || last[last.length - 1].time !== t) {
        // 新开一根：open = 若存在上一根则用上一根 close，否则 nextPrice
        const prev = last[last.length - 1];
        const open = prev ? prev.close : nextPrice;
        bar = { period, time: t, open, high: Math.max(open, nextPrice), low: Math.min(open, nextPrice), close: nextPrice, volume: volumeTick };
      } else {
        const l = last[last.length - 1];
        bar = {
          period, time: t,
          open: l.open,
          high: Math.max(l.high, nextPrice),
          low: Math.min(l.low, nextPrice),
          close: nextPrice,
          volume: (l.volume || 0) + volumeTick,
        };
      }
      db.upsertATokenKlineRow(bar);
    }

    // 同步 pool 当前价
    aTokenService.setPrice(nextPrice.toFixed(8));
    // 价格变动后触发限价挂单撮合
    try { orderService?.matchOpenOrders?.(); } catch (e) { console.error('[A币K线] tickLiveBar 撮合错误', e?.message || e); }
    console.log(`[A币K线] tick ok mode=${settings.mode} price ${Number(curPrice).toFixed(8)} → ${Number(nextPrice).toFixed(8)}`);
    return { nextPrice, mode: settings.mode };
  }

  // 手动"收盘"当前周期的 live bar（可用于后台快速造 K 线）
  function closeCurrentBar(period) {
    if (!PERIOD_SECONDS[period]) throw new Error('period 无效');
    const nowS = Math.floor(clock() / 1000);
    const sec = PERIOD_SECONDS[period];
    const curTime = periodStart(nowS, period);
    const last = db.listATokenKlines(period, 1);
    if (!last.length || last[last.length - 1].time !== curTime) return { closed: false };
    // 什么都不用做（tick 会继续更新），这里只返回它
    return { closed: true, bar: last[last.length - 1] };
  }

  function status() {
    const out = { settings: getSettings(), periods: {} };
    for (const p of ORDERED_PERIODS) out.periods[p] = { count: db.countATokenKlines(p) };
    // daily 模式：输出当日平滑推进进度，供后台面板展示
    try {
      const s = out.settings;
      if (s.mode === 'daily' && s.daily?.startPrice > 0) {
        const pct = clampDailyPct(s.dailyChangePct);
        const start = Number(s.daily.startPrice);
        const target = +(start * (1 + pct / 100)).toFixed(8);
        const window = Math.max(1, s.daily.endTimeS - s.daily.startTimeS);
        const nowS2 = Math.floor(clock() / 1000);
        const progress = clamp((nowS2 - s.daily.startTimeS) / window, 0, 1);
        // 当前"理论平滑位置"用 buildKeypoints(6段)+ akimaPath 算一次
        const kps = buildKeypoints({ startPrice: start, targetPrice: target, seed: (Math.round(s.daily.startTimeS) ^ Math.round(target * 1e7)) >>> 0 });
        const smoothNow = +(Math.max(0.0001, akimaPath(kps)(progress))).toFixed(8);
        out.dailyProgress = {
          dayKey: s.daily.dayKey,
          startTimeS: s.daily.startTimeS,
          endTimeS: s.daily.endTimeS,
          startPrice: start,
          targetEodPrice: target,
          currentSmoothPrice: smoothNow,
          progressPct: +(progress * 100).toFixed(4),
          fixed: false,
        };
      }
    } catch { /* 忽略展示性错误 */ }
    return out;
  }

  return {
    PERIOD_SECONDS, ORDERED_PERIODS,
    ensureSeeded, rebuildAll,
    listKlines, appendCandle,
    tickLiveBar, closeCurrentBar,
    getSettings, saveSettings,
    status,
  };
}
