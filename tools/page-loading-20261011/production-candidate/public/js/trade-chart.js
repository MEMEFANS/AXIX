let tradeChart = null;
let tradeChartLoading = null, tradeDeferredCandles = null;
let tradeCandleSeries = null;
let tradeLiveCandle = null;
let tradeLiveCandleHistory = [];
let tradeChartNeedsFit = true;
// 图表是否跟随最新 K 线：用户手动回翻历史时为 false，翻回最新边缘后自动恢复 true（币安同款行为）
let tradeChartFollowing = true;
// 高频行情合并：一帧内的多个成交只触发一次图表/指标更新
let tradeLiveRafScheduled = false;
let tradePendingLive = null;
let tradeMarkPriceLine = null;
let tradeEntryPriceLine = null;
let tradeExecutionMarkers = null;
let tradeLastPrice = null;
let tradeCurrentMarkPrice = null;
let tradeHeaderPriceMode = 'last';

// MA 简单移动平均线（主图）
const tradeMaSeries = new Map();
const tradeMaVisibility = new Map([[7, false], [25, false], [99, false]]);
const tradeMaColors = { 7:'#f0c84b', 25:'#e45bb7', 99:'#a88bdf' };

// EMA 指数移动平均线（主图）
const tradeEmaSeries = new Map();
const tradeEmaVisibility = new Map([[7, false], [25, false], [99, false]]);
const tradeEmaColors = { 7:'#2196f3', 25:'#ff9800', 99:'#9c27b0' };

// BOLL 布林带（主图）
let tradeBollUpper = null, tradeBollMiddle = null, tradeBollLower = null;
let tradeBollVisibility = false;
const BOLL_PERIOD = 20, BOLL_STD = 2;
const BOLL_COLOR = '#4a9eff';

// VOL 成交量（副图）
let tradeVolSeries = null;
let tradeVolVisibility = false;
let tradeVolPaneIdx = -1;

// MACD（副图）
let tradeMacdLineSeries = null, tradeMacdSignalSeries = null, tradeMacdHistSeries = null;
let tradeMacdVisibility = false;
let tradeMacdPaneIdx = -1;
const MACD_FAST = 12, MACD_SLOW = 26, MACD_SIGNAL = 9;
const MACD_LINE_COLOR = '#4fd1b5', MACD_SIGNAL_COLOR = '#f06f75', MACD_HIST_UP = '#4fd1b5', MACD_HIST_DOWN = '#f06f75';

// 实时增量指标状态（避免每个成交 tick 都全量 O(n) 重算，手机端卡顿/价格延迟的根因）
const tradeEmaLive = new Map(); // period -> { prev: 前一根EMA, cur: 最新一根EMA }
let tradeMacdLive = null;       // { fPrev, fCur, sPrev, sCur, sigPrev, sigCur }

// 完整 K 线数据缓存（含 volume），供所有指标计算使用
let tradeCandleData = [];

// ── 指标计算 ─────────────────────────────────────────────────────────────

function movingAverage(candles, period) {
  let sum = 0;
  return candles.map((c, index) => {
    sum += c.close;
    if (index >= period) sum -= candles[index - period].close;
    return index + 1 < period ? null : { time:c.time, value:sum / period };
  }).filter(Boolean);
}

/** 原始 EMA 数组（与输入等长，从第一根开始累积） */
function emaRaw(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = values[0] || 0;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[i] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** EMA 序列（从 period-1 开始有值），格式 {time, value}[] */
function emaSeries(candles, period) {
  const closes = candles.map(c => c.close);
  const raw = emaRaw(closes, period);
  return candles.map((c, i) => i + 1 < period ? null : { time:c.time, value:raw[i] }).filter(Boolean);
}

/** 布林带 {time, upper, middle, lower}[] */
function bollingerBands(candles, period = BOLL_PERIOD, stdDev = BOLL_STD) {
  const result = [];
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1);
    const mean = slice.reduce((s, c) => s + c.close, 0) / period;
    const variance = slice.reduce((s, c) => s + (c.close - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    result.push({ time:candles[i].time, upper:mean + stdDev * sd, middle:mean, lower:mean - stdDev * sd });
  }
  return result;
}

/** MACD {macdLine, signalLine, hist} — 均为 {time, value}[] */
function macdSeries(candles, fast = MACD_FAST, slow = MACD_SLOW, signal = MACD_SIGNAL) {
  const closes = candles.map(c => c.close);
  const emaF = emaRaw(closes, fast);
  const emaS = emaRaw(closes, slow);

  const macdData = [];
  for (let i = slow - 1; i < candles.length; i++) {
    macdData.push({ time:candles[i].time, value:emaF[i] - emaS[i] });
  }

  const macdVals = macdData.map(d => d.value);
  const sigRaw = emaRaw(macdVals, signal);
  const signalData = [];
  for (let i = signal - 1; i < macdData.length; i++) {
    signalData.push({ time:macdData[i].time, value:sigRaw[i] });
  }

  const histData = [];
  for (let i = 0; i < signalData.length; i++) {
    const mv = macdData[i + signal - 1].value;
    const diff = mv - signalData[i].value;
    histData.push({ time:signalData[i].time, value:diff, color:diff >= 0 ? MACD_HIST_UP : MACD_HIST_DOWN });
  }
  return { macdLine:macdData, signalLine:signalData, hist:histData };
}

/** 成交量柱状图数据 {time, value, color}[] */
function volumeData(candles) {
  return candles.map(c => ({
    time:c.time,
    value:Number(c.volume) || 0,
    color:c.close >= c.open ? 'rgba(79,209,181,0.5)' : 'rgba(240,111,117,0.5)',
  }));
}

/** 全量渲染后，用完整序列播种增量指标状态，之后实时 tick 只需 O(1) 更新最后一根 */
function seedTradeIndicatorState(data) {
  tradeEmaLive.clear();
  tradeMacdLive = null;
  if (!data || data.length < 2) return;
  const closes = data.map(c => c.close);
  for (const period of [7, 25, 99]) {
    const raw = emaRaw(closes, period);
    tradeEmaLive.set(period, {
      prev: raw[raw.length - 2] ?? raw[raw.length - 1],
      cur: raw[raw.length - 1],
    });
  }
  const f = emaRaw(closes, MACD_FAST);
  const s = emaRaw(closes, MACD_SLOW);
  const macdVals = [];
  for (let i = MACD_SLOW - 1; i < closes.length; i++) macdVals.push(f[i] - s[i]);
  if (macdVals.length >= MACD_SIGNAL) {
    const sig = emaRaw(macdVals, MACD_SIGNAL);
    tradeMacdLive = {
      fPrev: f[f.length - 2] ?? f[f.length - 1], fCur: f[f.length - 1],
      sPrev: s[s.length - 2] ?? s[s.length - 1], sCur: s[s.length - 1],
      sigPrev: sig[sig.length - 2] ?? sig[sig.length - 1], sigCur: sig[sig.length - 1],
    };
  }
}

// ── 图表初始化 ───────────────────────────────────────────────────────────

function ensureTradeChart() {
  if (tradeChart) return true;
  if (!window.Portal?.active('trade')) return false;
  if (typeof LightweightCharts === 'undefined') {
    if (!tradeChartLoading) {
      tradeChartLoading = window.loadPageCharts();
      tradeChartLoading.then(() => {
        if (!Portal.active('trade')) return;
        ensureTradeChart();
        const pending = tradeDeferredCandles;
        if (pending && pending.key === `${tradeProduct}:${tradeSymbol}:${tradeIntervalSec}`) renderTradeChartCandles(pending.raw);
      }).catch(() => {
        if (Portal.active('trade')) showToast('图表加载失败，请刷新重试', 'error');
      }).finally(() => { tradeChartLoading = null; });
    }
    return false;
  }
  const theme = window.WGTheme?.chartOptions?.() || {
    layout:{ background:{ type:'solid', color:'#0b0f0e' }, textColor:'#91a19b' },
    grid:{ vertLines:{ color:'#19211f' }, horzLines:{ color:'#19211f' } },
    rightPriceScale:{ borderColor:'#202a27' }, timeScale:{ borderColor:'#202a27' },
  };
  const tzOpts = (typeof window.wgChartTzOptions === 'function') ? window.wgChartTzOptions() : { localization:{}, timeScale:{} };
  const tradeChartHost = $('trade-chart');
  tradeChart = LightweightCharts.createChart(tradeChartHost, {
    width: tradeChartHost?.clientWidth || 600,
    height: tradeChartHost?.clientHeight || 360,
    layout:{ ...theme.layout, fontFamily:'-apple-system, Segoe UI, sans-serif' },
    grid:theme.grid,
    crosshair:{ mode:LightweightCharts.CrosshairMode.Normal },
    rightPriceScale:{ ...theme.rightPriceScale, scaleMargins:{ top:0.06, bottom:0.06 } },
    // 时间轴按浏览器本地时区显示（v5 默认 UTC，国内会差 8 小时，用共享 formatter 修正）；新成交到来时视图停留在最新边则自动跟随
    timeScale:{ ...theme.timeScale, ...tzOpts.timeScale, timeVisible:true, secondsVisible:false, rightOffset:4, barSpacing:11, fixLeftEdge:true, shiftVisibleRangeOnNewBar:true },
    localization:{ locale:'zh-CN', ...tzOpts.localization },
  });
  // base.css intentionally stacks ordinary mobile tables into cards. The
  // chart library uses an internal table to place the candle pane and price
  // scale side by side, so opt that private table out of the card layout.
  tradeChartHost?.querySelectorAll('.tv-lightweight-charts table').forEach(table => table.classList.add('no-mobile-stack'));
  // 手动接管尺寸同步：autoSize 在 iOS / 窄屏容器下测量不准（手机端 K 线偏移/留白）
  const fitTradeChart = () => {
    if (!tradeChart) return;
    const w = tradeChartHost?.clientWidth || 0;
    const h = tradeChartHost?.clientHeight || 360;
    if (w > 0) tradeChart.applyOptions({ width:w, height:h });
    // 手机地址栏收起/旋转会触发 resize，若正跟随最新则吸回，避免 K 线"跑出"屏幕
    if (w > 0 && tradeChartFollowing && tradeCandleData.length) {
      try { tradeChart.timeScale().scrollToRealTime(); } catch {}
    }
  };
  if (window.ResizeObserver && tradeChartHost) {
    new ResizeObserver(fitTradeChart).observe(tradeChartHost);
  }
  window.addEventListener('resize', fitTradeChart);
  window.visualViewport?.addEventListener?.('resize', fitTradeChart);
  fitTradeChart();
  tradeCandleSeries = tradeChart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor:'#4fd1b5', downColor:'#f06f75', borderVisible:false, wickUpColor:'#4fd1b5', wickDownColor:'#f06f75',
  });
  tradeExecutionMarkers = LightweightCharts.createSeriesMarkers(tradeCandleSeries, []);

  // 跟随模式：视图右缘停在最新 K 线附近时自动跟随实时；用户手动回翻历史则暂停跟随，
  // 翻回最新边缘自动恢复 —— 与币安一致，不需要手动拖回。
  tradeChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (!range || !Number.isFinite(Number(range.to)) || !tradeCandleData.length) return;
    tradeChartFollowing = Number(range.to) >= tradeCandleData.length - 1.5;
  });

  // MA 系列（主图，默认隐藏）
  for (const period of [7, 25, 99]) {
    const series = tradeChart.addSeries(LightweightCharts.LineSeries, {
      color:tradeMaColors[period], lineWidth:period === 99 ? 1 : 2, priceLineVisible:false, lastValueVisible:false,
    });
    series.applyOptions({ visible:tradeMaVisibility.get(period) });
    tradeMaSeries.set(period, series);
  }

  // EMA 系列（主图，默认隐藏）
  for (const period of [7, 25, 99]) {
    const series = tradeChart.addSeries(LightweightCharts.LineSeries, {
      color:tradeEmaColors[period], lineWidth:period === 99 ? 1 : 2, priceLineVisible:false, lastValueVisible:false,
    });
    series.applyOptions({ visible:Boolean(tradeEmaVisibility.get(period)) });
    tradeEmaSeries.set(period, series);
  }

  // BOLL 系列（主图，默认隐藏）
  tradeBollUpper = tradeChart.addSeries(LightweightCharts.LineSeries, {
    color:BOLL_COLOR, lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, priceLineVisible:false, lastValueVisible:false,
  });
  tradeBollMiddle = tradeChart.addSeries(LightweightCharts.LineSeries, {
    color:BOLL_COLOR, lineWidth:1, lineStyle:LightweightCharts.LineStyle.Solid, priceLineVisible:false, lastValueVisible:false,
  });
  tradeBollLower = tradeChart.addSeries(LightweightCharts.LineSeries, {
    color:BOLL_COLOR, lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, priceLineVisible:false, lastValueVisible:false,
  });
  tradeBollUpper.applyOptions({ visible:tradeBollVisibility });
  tradeBollMiddle.applyOptions({ visible:tradeBollVisibility });
  tradeBollLower.applyOptions({ visible:tradeBollVisibility });
  return true;
}

function updateTradeChartPriceFormat(price = 0) {
  if (!tradeCandleSeries) return;
  const decimals = Math.min(8, Math.max(2, Number(typeof tradePriceDecimalsFor === 'function'
    ? tradePriceDecimalsFor(tradeSymbol, price)
    : (Number(price) < 1 ? 8 : 2)) || 2));
  tradeCandleSeries.applyOptions({
    priceFormat:{ type:'price', precision:decimals, minMove:10 ** -decimals },
  });
}

window.addEventListener('wg-theme-change', event => {
  if (tradeChart) tradeChart.applyOptions(window.WGTheme?.chartOptions?.(event.detail?.theme) || {});
});

// 默认可见的 K 线数量（与币安等交易所一致，只显示最近一段，向左滚动查看历史）
const TRADE_VISIBLE_CANDLES = 60;

// 切换周期/交易对后，把视图滚动到最新蜡烛，同时保留当前缩放级别（蜡烛大小不变）。
// 首次加载不调用此函数，让 setData 按默认 barSpacing 自然展示。
function snapTradeChartToLatest() {
  if (!tradeChart || !tradeCandleData.length) return;
  const total = tradeCandleData.length;
  const range = tradeChart.timeScale().getVisibleLogicalRange();
  if (range && Number.isFinite(range.from) && Number.isFinite(range.to)) {
    const width = range.to - range.from;
    tradeChart.timeScale().setVisibleLogicalRange({ from: total - 1 - width, to: total - 1 });
  } else {
    // 首次无可见范围时，按默认蜡烛数显示最近一段
    const from = Math.max(0, total - TRADE_VISIBLE_CANDLES);
    tradeChart.timeScale().setVisibleLogicalRange({ from, to: total - 1 });
  }
}

// ── K 线渲染（全量刷新） ──────────────────────────────────────────────────

function renderTradeChartCandles(raw) {
  const data = raw.map(c => ({
    time:Math.floor(Number(c.time) / 1000), open:Number(c.open), high:Number(c.high), low:Number(c.low), close:Number(c.close),
    volume:Number(c.volume) || 0,
  })).filter(c => Number.isFinite(c.time) && Number.isFinite(c.close));
  if (!data.length) return null;
  const last = data[data.length - 1], day = data.slice(-24);
  const metrics = {
    last, high:Math.max(...day.map(c => c.high)), low:Math.min(...day.map(c => c.low)),
    change:(last.close / (day[0]?.open || last.open) - 1) * 100,
    volume:raw.slice(-24).reduce((sum, c) => sum + (Number(c.volume) || 0), 0),
  };
  tradeDeferredCandles = { raw, key:`${tradeProduct}:${tradeSymbol}:${tradeIntervalSec}` };
  // Prices and order entry can work while the optional chart library downloads.
  if (!ensureTradeChart()) return metrics;
  tradeDeferredCandles = null;
  updateTradeChartPriceFormat(data[0]?.close || 0);
  const hadPreviousData = tradeCandleData.length > 0;
  tradeCandleData = data;
  tradeCandleSeries.setData(data);
  updateTradeExecutionMarkers();
  tradeLiveCandleHistory = data.slice();

  // MA
  for (const period of [7, 25, 99]) {
    const series = tradeMaSeries.get(period);
    if (series) series.setData(movingAverage(data, period));
  }
  // EMA
  for (const period of [7, 25, 99]) {
    const series = tradeEmaSeries.get(period);
    if (series) series.setData(emaSeries(data, period));
  }
  // BOLL
  const boll = bollingerBands(data);
  tradeBollUpper?.setData(boll.map(p => ({ time:p.time, value:p.upper })));
  tradeBollMiddle?.setData(boll.map(p => ({ time:p.time, value:p.middle })));
  tradeBollLower?.setData(boll.map(p => ({ time:p.time, value:p.lower })));
  // VOL
  if (tradeVolSeries) tradeVolSeries.setData(volumeData(data));
  // MACD
  if (tradeMacdLineSeries) {
    const m = macdSeries(data);
    tradeMacdLineSeries.setData(m.macdLine);
    tradeMacdSignalSeries.setData(m.signalLine);
    tradeMacdHistSeries.setData(m.hist);
  }
  // 播种增量指标状态，实时 tick 走 O(1) 更新而非全量重算
  seedTradeIndicatorState(data);

  tradeLiveCandle = { ...data[data.length - 1] };
  if (tradeChartNeedsFit) {
    // 首次加载（之前无数据）：让 setData 按默认 barSpacing 自然展示最近蜡烛，
    // 不强制 setVisibleLogicalRange，避免蜡烛被过度压缩。
    // 切换周期/交易对后：滚动到最新蜡烛，保留当前缩放级别。
    if (hadPreviousData) snapTradeChartToLatest();
    tradeChartFollowing = true;
    tradeChartNeedsFit = false;
  }
  return metrics;
}

// ── 实时价格更新 ──────────────────────────────────────────────────────────

// 实时价格入口：最新价文本立即刷新（极廉价），K 线/指标更新合并到下一帧执行。
// 币安 BTC 每秒可达十多笔成交，旧逻辑每个 tick 全量 O(n) 重算 EMA/MACD，
// 手机端主线程被阻塞，价格反而显得比币安慢。
function applyTradeLivePrice(price, receivedAt = Date.now()) {
  const nextPrice = Number(price);
  if (!(nextPrice > 0) || !tradeCandleSeries) return;
  tradeLastPrice = nextPrice;
  const priceCell = document.querySelector(`[data-price="${tradeSymbol}"]`);
  if (priceCell) priceCell.textContent = formatTradePrice(nextPrice);
  const bookMid = $('trade-book-mid');
  if (bookMid) bookMid.textContent = formatTradePrice(nextPrice);
  tradePendingLive = { price:nextPrice, receivedAt:Number(receivedAt) || Date.now() };
  if (tradeLiveRafScheduled) return;
  tradeLiveRafScheduled = true;
  const schedule = window.requestAnimationFrame
    ? cb => window.requestAnimationFrame(cb)
    : cb => setTimeout(cb, 16);
  schedule(() => {
    tradeLiveRafScheduled = false;
    const tick = tradePendingLive;
    tradePendingLive = null;
    if (tick) applyTradeLivePriceChart(tick.price, tick.receivedAt);
    refreshTradeHeaderPrice();
    // 帧等待期间可能已切换交易对（resetTradeHeaderPrices 会把 tradeLastPrice 置空），
    // 优先用本帧 tick 自带的价格，并做数值校验，避免 null.toFixed 报错中断本帧后续刷新
    const framePrice = Number(tick?.price) > 0 ? tick.price : tradeLastPrice;
    if (tradeOrderType !== 'limit') {
      const input = $('trade-order-price');
      const p = Number(framePrice);
      if (input && document.activeElement !== input && p > 0) input.value = p.toFixed(tradePriceDecimals(p));
    }
    // 详情面板隐藏时无意义，打开详情时 setTradeChartView 会立即刷新
    if (!$('trade-chart-details')?.hidden && typeof updateTradeMarketDetails === 'function') updateTradeMarketDetails();
  });
}

function applyTradeLivePriceChart(nextPrice, receivedAt) {
  if (!(nextPrice > 0) || !tradeCandleSeries) return;
  const time = Math.floor(Number(receivedAt) / 1000 / tradeIntervalSec) * tradeIntervalSec;
  const isNewBar = !tradeLiveCandle || time > tradeLiveCandle.time;
  if (tradeLiveCandle && time < tradeLiveCandle.time) return; // 乱序/过期 tick 不回改 K 线
  if (isNewBar) {
    const previousClose = tradeLiveCandle?.close || nextPrice;
    tradeLiveCandle = { time, open:previousClose, high:nextPrice, low:nextPrice, close:nextPrice, volume:0 };
  } else {
    tradeLiveCandle = { ...tradeLiveCandle, high:Math.max(tradeLiveCandle.high,nextPrice), low:Math.min(tradeLiveCandle.low,nextPrice), close:nextPrice };
  }
  const histLast = tradeLiveCandleHistory[tradeLiveCandleHistory.length - 1];
  if (histLast && histLast.time === tradeLiveCandle.time) tradeLiveCandleHistory[tradeLiveCandleHistory.length - 1] = tradeLiveCandle;
  else tradeLiveCandleHistory.push(tradeLiveCandle);
  if (tradeCandleData.length && tradeCandleData[tradeCandleData.length - 1].time === time) {
    tradeCandleData[tradeCandleData.length - 1] = tradeLiveCandle;
  } else {
    tradeCandleData.push(tradeLiveCandle);
  }
  tradeCandleSeries.update(tradeLiveCandle);

  // MA（O(period)，仅最近几根求和，始终保持数据最新）
  for (const [period, series] of tradeMaSeries) {
    const history = tradeLiveCandleHistory?.slice(-period) || [];
    if (history.length >= period) series.update({ time, value:history.reduce((sum,c)=>sum+c.close,0)/period });
  }
  // EMA —— O(1) 增量：ema(n) = close*k + ema(n-1)*(1-k)
  for (const [period, series] of tradeEmaSeries) {
    const state = tradeEmaLive.get(period);
    if (!state) continue;
    if (isNewBar) state.prev = state.cur;
    const k = 2 / (period + 1);
    state.cur = nextPrice * k + state.prev * (1 - k);
    series.update({ time, value:state.cur });
  }
  // BOLL（O(period)，最近 20 根，始终保持数据最新）
  if (tradeCandleData.length >= BOLL_PERIOD) {
    const slice = tradeCandleData.slice(-BOLL_PERIOD);
    const mean = slice.reduce((s, c) => s + c.close, 0) / BOLL_PERIOD;
    const variance = slice.reduce((s, c) => s + (c.close - mean) ** 2, 0) / BOLL_PERIOD;
    const sd = Math.sqrt(variance);
    tradeBollUpper?.update({ time, value:mean + BOLL_STD * sd });
    tradeBollMiddle?.update({ time, value:mean });
    tradeBollLower?.update({ time, value:mean - BOLL_STD * sd });
  }
  // MACD —— O(1) 增量：DIF=EMA12-EMA26，DEA=EMA9(DIF)，HIST=DIF-DEA
  if (tradeMacdLive) {
    const st = tradeMacdLive;
    if (isNewBar) { st.fPrev = st.fCur; st.sPrev = st.sCur; st.sigPrev = st.sigCur; }
    const kf = 2 / (MACD_FAST + 1), ks = 2 / (MACD_SLOW + 1), kg = 2 / (MACD_SIGNAL + 1);
    st.fCur = nextPrice * kf + st.fPrev * (1 - kf);
    st.sCur = nextPrice * ks + st.sPrev * (1 - ks);
    const dif = st.fCur - st.sCur;
    st.sigCur = dif * kg + st.sigPrev * (1 - kg);
    const hist = dif - st.sigCur;
    tradeMacdLineSeries?.update({ time, value:dif });
    tradeMacdSignalSeries?.update({ time, value:st.sigCur });
    tradeMacdHistSeries?.update({ time, value:hist, color:hist >= 0 ? MACD_HIST_UP : MACD_HIST_DOWN });
  }

  // 视图停在最新边缘时自动跟随（用户手动回翻历史期间不打断）
  if (tradeChartFollowing) {
    try { tradeChart.timeScale().scrollToRealTime(); } catch {}
  }
}

// ── 头部价格 / 标记价 ──────────────────────────────────────────────────────

function refreshTradeHeaderPrice() {
  const preferred = tradeHeaderPriceMode === 'mark' ? tradeCurrentMarkPrice : tradeLastPrice;
  const fallback = tradeHeaderPriceMode === 'mark' ? tradeLastPrice : tradeCurrentMarkPrice;
  const price = Number(preferred) > 0 ? preferred : fallback;
  $('trade-mark-price').textContent = Number(price) > 0 ? formatTradePrice(price) : '—';
}

function setTradeHeaderPriceMode(mode) {
  tradeHeaderPriceMode = mode === 'mark' ? 'mark' : 'last';
  const showMark = tradeHeaderPriceMode === 'mark';
  tradeCandleSeries?.applyOptions({
    priceLineVisible:!showMark,
    lastValueVisible:!showMark,
  });
  tradeMarkPriceLine?.applyOptions({
    lineVisible:showMark,
    axisLabelVisible:showMark,
  });
  refreshTradeHeaderPrice();
}

function resetTradeHeaderPrices() {
  tradeLastPrice = null;
  tradeCurrentMarkPrice = null;
  refreshTradeHeaderPrice();
}

// ── 成交箭头标记 ───────────────────────────────────────────────────────────

function updateTradeExecutionMarkers() {
  if (!tradeExecutionMarkers) return;
  if (tradeProduct !== 'perp') {
    tradeExecutionMarkers.setMarkers([]);
    return;
  }
  const fills = (platformProfile?.fills || [])
    .filter(fill => fill.product === 'perp' && fill.symbol === tradeSymbol)
    .slice().sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const markers = fills.map(fill => {
    const isBuy = fill.side === 'buy';
    const timestamp = Date.parse(fill.createdAt);
    const fillPrice = Number(fill.price);
    return {
      time:Math.floor(timestamp / 1000 / tradeIntervalSec) * tradeIntervalSec,
      position:isBuy ? 'atPriceBottom' : 'atPriceTop',
      shape:isBuy ? 'arrowUp' : 'arrowDown',
      color:isBuy ? '#4fd1b5' : '#f06f75',
      price:fillPrice,
      size:0.8,
      text:isBuy ? 'B' : 'S',
    };
  }).filter(marker => Number.isFinite(marker.time) && marker.price > 0);
  tradeExecutionMarkers.setMarkers(markers);
}

function applyTradeMarkPrice(price) {
  const nextPrice = Number(price);
  if (!(nextPrice > 0)) return;
  tradeCurrentMarkPrice = nextPrice;
  if (typeof updatePlatformPerpMark === 'function') updatePlatformPerpMark(tradeSymbol, nextPrice);
  refreshTradeHeaderPrice();
  if (!tradeCandleSeries) return;
  if (!tradeMarkPriceLine) {
    tradeMarkPriceLine = tradeCandleSeries.createPriceLine({
      price:nextPrice, color:'#f0c84b', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed,
      lineVisible:tradeHeaderPriceMode === 'mark', axisLabelVisible:tradeHeaderPriceMode === 'mark', title:'标记',
    });
  } else {
    tradeMarkPriceLine.applyOptions({ price:nextPrice });
  }
}

function updateTradeEntryPriceLine(price, side) {
  if (!tradeCandleSeries) return;
  const p = Number(price);
  if (!(p > 0)) {
    if (tradeEntryPriceLine) { try { tradeCandleSeries.removePriceLine(tradeEntryPriceLine); } catch {} tradeEntryPriceLine = null; }
    return;
  }
  const color = side === 'sell' ? '#f06f75' : '#4fd1b5';
  const title = side === 'sell' ? '做空' : '做多';
  if (!tradeEntryPriceLine) {
    tradeEntryPriceLine = tradeCandleSeries.createPriceLine({
      price: p, color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title
    });
  } else {
    tradeEntryPriceLine.applyOptions({ price: p, color, title });
  }
}

window.updateTradeEntryPriceLine = updateTradeEntryPriceLine;

// ── EMA 指标切换 ──────────────────────────────────────────────────────────

function setTradeEma(period, visible = !tradeEmaVisibility.get(period)) {
  tradeEmaVisibility.set(period, visible);
  tradeEmaSeries.get(period)?.applyOptions({ visible });
  document.querySelectorAll(`[data-indicator="ema"][data-period="${period}"], [data-indicator-period="ema-${period}"]`).forEach(btn => btn.classList.toggle('active', visible));
  document.querySelector(`[data-indicator-period="ema-${period}"] b`)?.replaceChildren(visible ? '开启' : '关闭');
}

// ── BOLL 指标切换 ─────────────────────────────────────────────────────────

function setTradeBoll(visible = !tradeBollVisibility) {
  tradeBollVisibility = visible;
  tradeBollUpper?.applyOptions({ visible });
  tradeBollMiddle?.applyOptions({ visible });
  tradeBollLower?.applyOptions({ visible });
  document.querySelectorAll('[data-indicator="boll"], [data-indicator-period="boll"]').forEach(btn => btn.classList.toggle('active', visible));
  document.querySelector('[data-indicator-period="boll"] b')?.replaceChildren(visible ? '开启' : '关闭');
}

// ── VOL 副图切换 ──────────────────────────────────────────────────────────

function setTradeVol(visible = !tradeVolVisibility) {
  if (!ensureTradeChart()) return;
  tradeVolVisibility = visible;
  if (visible) {
    if (!tradeVolSeries) {
      tradeVolPaneIdx = tradeChart.panes().length;
      tradeChart.addPane();
      tradeVolSeries = tradeChart.addSeries(LightweightCharts.HistogramSeries, {
        priceFormat:{ type:'volume' }, priceScaleId:'vol', color:'rgba(79,209,181,0.5)',
      }, tradeVolPaneIdx);
      tradeVolSeries.priceScale().applyOptions({ scaleMargins:{ top:0.15, bottom:0 } });
      tradeChart.panes()[tradeVolPaneIdx]?.setHeight(100);
      if (tradeCandleData.length) tradeVolSeries.setData(volumeData(tradeCandleData));
    }
    tradeVolSeries.applyOptions({ visible:true });
    tradeChart.panes()[tradeVolPaneIdx]?.setStretchFactor(0.18);
  } else if (tradeVolSeries) {
    tradeVolSeries.applyOptions({ visible:false });
    tradeChart.panes()[tradeVolPaneIdx]?.setStretchFactor(0.001);
  }
  document.querySelectorAll('[data-indicator="vol"], [data-indicator-period="vol"]').forEach(btn => btn.classList.toggle('active', visible));
  document.querySelector('[data-indicator-period="vol"] b')?.replaceChildren(visible ? '开启' : '关闭');
}

// ── MACD 副图切换 ─────────────────────────────────────────────────────────

function setTradeMacd(visible = !tradeMacdVisibility) {
  if (!ensureTradeChart()) return;
  tradeMacdVisibility = visible;
  if (visible) {
    if (!tradeMacdLineSeries) {
      tradeMacdPaneIdx = tradeChart.panes().length;
      tradeChart.addPane();
      tradeMacdLineSeries = tradeChart.addSeries(LightweightCharts.LineSeries, {
        color:MACD_LINE_COLOR, lineWidth:2, priceLineVisible:false, lastValueVisible:false,
      }, tradeMacdPaneIdx);
      tradeMacdSignalSeries = tradeChart.addSeries(LightweightCharts.LineSeries, {
        color:MACD_SIGNAL_COLOR, lineWidth:1, priceLineVisible:false, lastValueVisible:false,
      }, tradeMacdPaneIdx);
      tradeMacdHistSeries = tradeChart.addSeries(LightweightCharts.HistogramSeries, {
        priceLineVisible:false, lastValueVisible:false,
      }, tradeMacdPaneIdx);
      tradeChart.panes()[tradeMacdPaneIdx]?.setHeight(120);
      if (tradeCandleData.length) {
        const m = macdSeries(tradeCandleData);
        tradeMacdLineSeries.setData(m.macdLine);
        tradeMacdSignalSeries.setData(m.signalLine);
        tradeMacdHistSeries.setData(m.hist);
      }
    }
    tradeMacdLineSeries.applyOptions({ visible:true });
    tradeMacdSignalSeries.applyOptions({ visible:true });
    tradeMacdHistSeries.applyOptions({ visible:true });
    tradeChart.panes()[tradeMacdPaneIdx]?.setStretchFactor(0.2);
  } else if (tradeMacdLineSeries) {
    tradeMacdLineSeries.applyOptions({ visible:false });
    tradeMacdSignalSeries.applyOptions({ visible:false });
    tradeMacdHistSeries.applyOptions({ visible:false });
    tradeChart.panes()[tradeMacdPaneIdx]?.setStretchFactor(0.001);
  }
  document.querySelectorAll('[data-indicator="macd"], [data-indicator-period="macd"]').forEach(btn => btn.classList.toggle('active', visible));
  document.querySelector('[data-indicator-period="macd"] b')?.replaceChildren(visible ? '开启' : '关闭');
}
