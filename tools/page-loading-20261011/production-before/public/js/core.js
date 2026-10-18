// ── 工具函数 ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const fmt = (v, d=2) => v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d });
const fmtMarketPrice = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const digits = n >= 1000 ? 2 : n >= 1 ? 4 : 8;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits });
};
const signed = (v) => v == null ? '—' : (v >= 0 ? '+' : '') + fmt(v);
const cls = (v) => v == null ? '' : (v >= 0 ? 'up' : 'down');
const round = (x) => Math.round(x * 100) / 100;
const pnlHtml = (v) => v == null ? '—' : `<span class="${cls(v)}">${signed(v)}</span>`;
const tradeMoneyHtml = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const value = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return `<span class="${cls(n)}">${n >= 0 ? '+' : ''}${value}</span>`;
};
const tradeTime = (value) => new Date(value).toLocaleString('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const renderFills = (fills) => {
  if (!Array.isArray(fills) || fills.length === 0) {
    return '<tr><td class="empty-row" colspan="7">暂无成交</td></tr>';
  }
  return fills.map((f) => {
    const kind = f.kind === 'recovery' ? '回收' : f.kind === 'close' || f.closing ? '平仓' : '开仓';
    const side = f.side === 'buy' ? '买' : '卖';
    return `<tr><td data-label="时间">${tradeTime(f.t)}</td><td data-label="类型">${kind}</td><td data-label="方向"><span class="pill ${f.side === 'buy' ? 'pill-buy' : 'pill-sell'}">${side}</span></td><td data-label="成交价">${fmt(f.price, 8)}</td><td data-label="数量">${fmt(f.size, 8)}</td><td data-label="手续费">${f.fee == null ? '—' : fmt(f.fee, 4)}</td><td data-label="本笔盈亏">${tradeMoneyHtml(f.realizedPnl)}</td></tr>`;
  }).join('');
};
setInterval(() => {
  const time = $('hdr-time');
  if (time) time.textContent = new Date().toLocaleTimeString('zh-CN');
}, 1000);

const RISK = {
  steady:     { rMul:4, rMin:.02, rMax:.06, sMul:.5, sMin:.5, sMax:1, lev:{hi:2,mid:2,lo:3}, budget:.70, skew:1.2, hint:'成交少·更安全·覆盖广' },
  aggressive: { rMul:2.5, rMin:.015, rMax:.04, sMul:.25, sMin:.2, sMax:.5, lev:{hi:3,mid:5,lo:8}, budget:.90, skew:1.4, hint:'成交频繁·收益与风险更高' },
};

// ── Tab 切换 ────────────────────────────────────────────────────────────────
function toggleMobileNav(force) {
  const header = document.querySelector('.header');
  const button = $('mobile-nav-toggle');
  const backdrop = $('mobile-nav-backdrop');
  if (!header || !button) return;
  const open = force === undefined ? !header.classList.contains('mobile-nav-open') : Boolean(force);
  header.classList.toggle('mobile-nav-open', open);
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
  backdrop?.setAttribute('aria-hidden', String(!open));
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') toggleMobileNav(false);
});

let pageNavigationSeq = 0;
async function switchTab(name) {
  const navigation = ++pageNavigationSeq;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const panel = $('tab-' + name);
  if (!panel) return;
  panel.classList.add('active');
  if (name !== 'trade') tradeMarketStream?.close();
  else if (window.__tradeDeferredReady) initTradeMarketStream();
  const nav = ['de', 'ex', 'rs'].includes(name)
    ? document.querySelector('[data-strategy-nav]')
    : document.querySelector(`.tab-btn[onclick="switchTab('${name}')"]`);
  nav?.classList.add('active');
  toggleMobileNav(false);
  const pending = window.isPageModuleReady?.(name) ? null : window.loadPageModule?.(name);
  if (pending) {
    panel.setAttribute('aria-busy', 'true');
    panel.inert = true;
    const loading = document.createElement('div');
    loading.setAttribute('role','status');
    loading.textContent = '加载中';
    loading.style.cssText = 'padding:14px;text-align:center;color:#50d2c2';
    panel.prepend(loading);
    try { await pending; }
    catch (error) { showToast(error.message, 'error'); return false; }
    finally { loading.remove(); panel.inert = false; panel.removeAttribute('aria-busy'); }
    // Rapid page changes must not start an inactive page after its scripts finish downloading.
    if (navigation !== pageNavigationSeq || !panel.classList.contains('active')) return false;
  }
  if (name === 'ledger') loadLedger(true);
  if (name === 'account') {
    if (typeof loadWalletConfig === 'function' && !walletConfig) loadWalletConfig().catch(() => {});
    window.ExchangeAssets?.activate();
  }
  if (name === 'ai') aiRefreshStatus();
  if (name === 'overview') window.InternalStrategyOverview?.activate?.();
  if (name === 'community') window.CommunityLinks?.load();
  if (name === 'ai-managed') window.AiManaged?.activate();
  if (window.Portal?.pages?.[name]) window.Portal.load(name);
  if (name === 'trade') setTimeout(() => { if (typeof snapTradeChartToLatest === 'function') snapTradeChartToLatest(); else tradeChart?.timeScale().fitContent(); }, 50);
  if (['de', 'ex', 'rs'].includes(name)) {
    setTimeout(() => window.exchangeCtrls?.[name]?.activate?.(), 50);
  }
  return true;
}

async function openTradePage(product, symbol) {
  if (!await switchTab('trade')) return;
  tradeProduct = product === 'perp' ? 'perp' : 'spot';
  window.tradeProduct = tradeProduct;
  setTradeMarketScope('crypto');
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  $('tab-trade').classList.add('active');
  document.querySelector(`[data-trade-nav="${tradeProduct}"]`)?.classList.add('active');
  toggleMobileNav(false);
  $('trade-mark-price').textContent='加载中';
  $('trade-order-price').value='';
  setTradeProduct(tradeProduct);
  if (symbol) setTradeSymbol(symbol);
  initTradeMarketStream();
  setTimeout(()=>{ if (typeof snapTradeChartToLatest === 'function') snapTradeChartToLatest(); else tradeChart?.timeScale().fitContent(); },50);
}

// 股票交易入口：复用现货/合约终端，仅把市场范围切到美股代币
async function openStockPage(product) {
  if (!await switchTab('trade')) return;
  tradeProduct = product === 'perp' ? 'perp' : 'spot';
  window.tradeProduct = tradeProduct;
  setTradeMarketScope('stock');
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  $('tab-trade').classList.add('active');
  document.querySelector('[data-trade-nav="stock"]')?.classList.add('active');
  toggleMobileNav(false);
  $('trade-mark-price').textContent='加载中';
  $('trade-order-price').value='';
  setTradeProduct(tradeProduct);
  // 目录尚未加载完成时，loadTradeMarkets() 会依据 stock scope 自动选中默认股票
  if (!TRADE_MARKETS.some(item => item.symbol === tradeSymbol && item.category === 'stock' && item[tradeProduct])) {
    const firstStock = TRADE_MARKETS.find(item => item.category === 'stock' && item[tradeProduct]);
    if (firstStock) setTradeSymbol(firstStock.symbol);
  }
  initTradeMarketStream();
  setTimeout(()=>{ if (typeof snapTradeChartToLatest === 'function') snapTradeChartToLatest(); else tradeChart?.timeScale().fitContent(); },50);
}

function setTradeMarketScope(scope) {
  tradeMarketScope = scope === 'stock' ? 'stock' : 'crypto';
  window.tradeMarketScope = tradeMarketScope;
  tradeMarketCategory = 'product';
  document.querySelectorAll('[data-market-scope]').forEach(button => button.classList.toggle('active', tradeMarketScope === 'stock'));
}

let tradeIntervalSec = 3600;
let tradeMarketRequest = 0;
let tradeMarketStream = null;
let tradeOrderBookRequest = null;
let tradeMarketCategory = 'product';
let tradeMarketScope = 'crypto'; // 'crypto' 普通币种 | 'stock' 美股代币
window.tradeMarketScope = tradeMarketScope;
const tradeLatestTicks = new Map();
const tradeLatestMarks = new Map();
const tradeMarketSummaries = new Map();
const tradeMarketOverviewRequests = new Map();

function tradeMarketKey(product = tradeProduct, symbol = tradeSymbol) {
  return `${product}:${symbol}`;
}

function showToast(message, type = '') {
  let toast = $('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.className = 'app-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `app-toast ${type} show`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 6500);
}

function showConfirm({ title = '确认操作', lines = [], confirmText = '确认', cancelText = '取消', danger = false }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'aim-confirm-overlay';
    overlay.innerHTML = `
      <div class="aim-confirm-dialog${danger ? ' danger' : ''}">
        <h3>${title}</h3>
        <ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>
        <div class="aim-confirm-actions">
          <button type="button" class="aim-confirm-cancel">${cancelText}</button>
          <button type="button" class="aim-confirm-ok${danger ? ' danger' : ''}">${confirmText}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cleanup = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector('.aim-confirm-cancel').onclick = () => cleanup(false);
    overlay.querySelector('.aim-confirm-ok').onclick = () => cleanup(true);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
    overlay.querySelector('.aim-confirm-ok').focus();
  });
}

// 简易确认弹窗：单条消息，返回 Promise<boolean>
function confirmDialog(message, { title = '确认', danger = false } = {}) {
  return showConfirm({ title, lines: [String(message)], danger });
}

// 输入弹窗：返回 Promise<string|null>（取消返回 null）
function promptDialog(message, defaultValue = '') {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'aim-confirm-overlay';
    overlay.innerHTML = `
      <div class="aim-confirm-dialog">
        <h3>请输入</h3>
        <ul><li>${String(message).replace(/\n/g, '<br>')}</li></ul>
        <input type="text" class="aim-prompt-input" value="${String(defaultValue).replace(/"/g, '&quot;')}" />
        <div class="aim-confirm-actions">
          <button type="button" class="aim-confirm-cancel">取消</button>
          <button type="button" class="aim-confirm-ok">确定</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.aim-prompt-input');
    const cleanup = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector('.aim-confirm-cancel').onclick = () => cleanup(null);
    overlay.querySelector('.aim-confirm-ok').onclick = () => cleanup(input.value);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(null); };
    input.focus();
    input.select();
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') cleanup(input.value); });
  });
}

// 全局覆盖原生 alert/confirm：统一使用暗色居中弹窗，与主题一致
// alert 不阻塞、不返回值，连续调用时排队显示
(function overrideNativeDialogs() {
  const alertQueue = [];
  let alertShowing = false;
  function showAlertModal(message) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'aim-confirm-overlay';
      overlay.innerHTML = `
        <div class="aim-confirm-dialog">
          <h3>提示</h3>
          <ul><li>${String(message).replace(/\n/g, '<br>')}</li></ul>
          <div class="aim-confirm-actions">
            <button type="button" class="aim-confirm-ok">确定</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const cleanup = () => { overlay.remove(); resolve(); };
      overlay.querySelector('.aim-confirm-ok').onclick = cleanup;
      overlay.onclick = (e) => { if (e.target === overlay) cleanup(); };
      overlay.querySelector('.aim-confirm-ok').focus();
    });
  }
  async function pumpAlerts() {
    if (alertShowing) return;
    alertShowing = true;
    while (alertQueue.length) {
      const msg = alertQueue.shift();
      await showAlertModal(msg);
    }
    alertShowing = false;
  }
  window.alert = function (message) {
    alertQueue.push(message);
    pumpAlerts();
  };
  window.confirmDialog = confirmDialog;
  window.promptDialog = promptDialog;
})();

let tradeBookPrecision = 0.1;
// 订单簿上一帧价格集合，用于价格跳动闪烁标记
let lastBookPrices = { asks: [], bids: [] };

function renderTerminalBook(book) {
  const precision = Number($('trade-book-precision')?.value) || tradeBookPrecision;
  tradeBookPrecision = precision;
  // 聚合：按精度合并相同价位
  const aggregate = (rows) => {
    const map = new Map();
    rows.forEach(r => {
      const key = Math.floor(Number(r.price) / precision) * precision;
      const existing = map.get(key);
      if (existing) existing.size = Number(existing.size) + Number(r.size);
      else map.set(key, { price: key, size: Number(r.size) });
    });
    return [...map.values()];
  };
  const rawBids = book.bids || [];
  const rawAsks = book.asks || [];
  const bids = aggregate(rawBids).sort((a,b) => b.price - a.price).slice(0, 12);
  const asks = aggregate(rawAsks).sort((a,b) => a.price - b.price).slice(0, 12);
  // 累计量：买卖盘共用同一标尺，背景条视觉对称
  let bidCum = 0, askCum = 0;
  const bidVals = bids.map(r => ({ ...r, total: (bidCum += Number(r.size) || 0) }));
  const askVals = asks.map(r => ({ ...r, total: (askCum += Number(r.size) || 0) }));
  const maxTotal = Math.max(bidVals[bidVals.length - 1]?.total || 1, askVals[askVals.length - 1]?.total || 1);
  // 买卖盘总量比例条（参考币安/OKX 手机端）
  const bidTotal = bidVals[bidVals.length - 1]?.total || 0;
  const askTotal = askVals[askVals.length - 1]?.total || 0;
  const bookSum = bidTotal + askTotal;
  const bidPct = bookSum > 0 ? Math.round(bidTotal / bookSum * 100) : 50;
  const askPct = 100 - bidPct;
  const spreadBar = $('trade-book-spread-bar');
  if (spreadBar) {
    // 买卖盘两侧均无量时保持隐藏，避免 50/50 红绿条误导
    if (bookSum <= 0) {
      spreadBar.hidden = true;
    } else {
      spreadBar.hidden = false;
      spreadBar.style.setProperty('--bid-pct', bidPct + '%');
      spreadBar.style.setProperty('--ask-pct', askPct + '%');
      const bidEl = $('trade-book-bid-pct');
      const askEl = $('trade-book-ask-pct');
      if (bidEl) bidEl.textContent = bidPct + '%';
      if (askEl) askEl.textContent = askPct + '%';
    }
  }
  const prevAsks = lastBookPrices.asks;
  const prevBids = lastBookPrices.bids;
  const makeRows = (rows, side, prevPrices) => rows.map((row) => {
    const depthPct = Math.max(2, (row.total / maxTotal) * 100);
    const isNew = !prevPrices.includes(row.price);
    return `<div class="book-row ${side}${isNew ? ' flash' : ''}" data-price="${row.price}" style="--depth:${depthPct}%;--depth-color:${side === 'ask' ? 'rgba(240,111,117,0.08)' : 'rgba(79,209,181,0.08)'}"><span>${formatTradePrice(row.price)}</span><span>${formatTradeAmount(row.size)}</span><span>${formatTradeAmount(row.total)}</span></div>`;
  }).join('');
  // 卖盘倒序：最高价在顶部，最优卖价（最低）紧邻中间价
  $('trade-asks').innerHTML = makeRows([...askVals].reverse(), 'ask', prevAsks);
  $('trade-bids').innerHTML = makeRows(bidVals, 'bid', prevBids);
  lastBookPrices = { asks: askVals.map(r => r.price), bids: bidVals.map(r => r.price) };
  // 中间价 + 价差
  const bestBid = Number(bids[0]?.price || 0);
  const bestAsk = Number(asks[0]?.price || 0);
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk);
  const spread = bestAsk - bestBid;
  const spreadPct = mid > 0 ? (spread / mid * 100) : 0;
  if (mid > 0) {
    $('trade-book-mid').innerHTML = `<span class="book-mid-price">$${formatTradePrice(mid)}</span><span class="book-spread">价差 ${formatTradePrice(spread)} <em>(${spreadPct.toFixed(3)}%)</em></span>`;
    const key = tradeMarketKey(tradeProduct, tradeSymbol);
    const now = Date.now();
    const latestTick = tradeLatestTicks.get(key);
    if (!latestTick || now - latestTick.receivedAt > 1500) {
      tradeLatestTicks.set(key, { price: mid, receivedAt: now });
      document.querySelector(`[data-price="${tradeSymbol}"]`)?.replaceChildren(formatTradeMarketPrice(tradeSymbol, mid));
    }
    // 价格提醒检查
    window.TradeAlerts?.check(tradeSymbol, mid);
  } else {
    $('trade-book-mid').innerHTML = `<span class="book-mid-price">—</span>`;
  }
  // 市价单预估成交价
  updateMarketEstPrice(bids, asks);
  window.TradeDepth?.render(book);
}

// 点击订单簿价格档位 → 填充限价单价格框
function initOrderBookClick() {
  const panel = $('trade-book-panel');
  if (!panel) return;
  panel.addEventListener('click', (e) => {
    const row = e.target.closest('.book-row');
    if (!row) return;
    const price = Number(row.dataset.price);
    if (!price || price <= 0) return;
    const priceInput = $('trade-order-price');
    if (priceInput && !priceInput.readOnly) {
      priceInput.value = price.toFixed(tradePriceDecimals(price));
      updateTradeOrderPanel();
      priceInput.focus();
    }
  });
}

function updateMarketEstPrice(bids, asks) {
  const priceField = $('trade-order-price-field');
  if (!priceField) return;
  const isMarket = tradeOrderType === 'market';
  const side = document.querySelector('.side-switch button.active')?.dataset.side || 'buy';
  if (isMarket) {
    const bestBid = Number(bids[0]?.price || 0);
    const bestAsk = Number(asks[0]?.price || 0);
    const est = side === 'buy' ? bestAsk : bestBid;
    if (est > 0) {
      const labelEl = priceField.querySelector('span');
      if (labelEl) labelEl.textContent = '价格';
      $('trade-order-price').value = est.toFixed(2);
    }
  } else {
    const labelEl = priceField.querySelector('span');
    if (labelEl) labelEl.textContent = '价格';
  }
}

async function refreshTradeOrderBook() {
  if (document.hidden || !$('tab-trade')?.classList.contains('active')) return;
  if (tradeOrderBookRequest) return tradeOrderBookRequest;
  tradeOrderBookRequest = (async () => {
  try {
    const product = tradeProduct, symbol = tradeSymbol;
    const response = await fetch(`/api/market/orderbook?product=${product}&symbol=${symbol}`);
    const book = await response.json();
    if (!response.ok) throw new Error(book.error || '订单簿读取失败');
    if (product !== tradeProduct || symbol !== tradeSymbol) return;
    renderTerminalBook(book);
  } catch (error) {
    console.warn('[trade] Binance order book temporarily unavailable:', error.message);
  }
  })();
  try { return await tradeOrderBookRequest; }
  finally { tradeOrderBookRequest = null; }
}

const BINANCE_LOGO_BASE = 'https://bin.bnbstatic.com/static/assets/logos';
// 币安股票官方徽章（App「传统金融→股票」同款纯品牌标）
const BINANCE_STOCK_LOGO_BASE = 'https://bin.bnbstatic.com/static/stock';
// 最终兜底：没有任何真实图标时生成品牌色字母头像（SVG data URI，零网络请求）
function stockLetterLogo(symbol) {
  const text = String(symbol || '').slice(0, 4);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#38b6a6"/><stop offset="1" stop-color="#2f8fd0"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><text x="32" y="40" font-family="Arial,sans-serif" font-size="${text.length > 2 ? 20 : 26}" font-weight="700" fill="#0b1113" text-anchor="middle">${text}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
// 本地主图标：股票与加密币统一走 /assets/tokens/{symbol}.png
function tradeMarketLogo(item) {
  return `/assets/tokens/${String(item.symbol || '').toLowerCase()}.png?v=5`;
}
// 币安 CDN 图标：加密币走 static/assets/logos；股票走官方徽章 static/stock
function marketRemoteLogo(item) {
  return item.category === 'stock'
    ? `${BINANCE_STOCK_LOGO_BASE}/${item.symbol}.png`
    : `${BINANCE_LOGO_BASE}/${item.symbol}.png`;
}
function marketFallbackLogo(item) {
  return item.category === 'stock' ? stockLetterLogo(item.symbol) : tradeMarketLogo(item);
}
// 本地图加载失败 → 币安 CDN → 最终兜底
function bindMarketLogo(img, market) {
  if (!img || !market) return;
  img.dataset.f = '';
  img.onerror = () => {
    if (!img.dataset.f) {
      img.dataset.f = '1';
      img.src = market.remoteLogo || market.fallbackLogo;
    } else {
      img.onerror = null;
      img.src = market.fallbackLogo;
    }
  };
  img.src = market.logo;
}
let TRADE_MARKETS = [
  {symbol:'BTC',spot:true,perp:true,priceDecimals:2,category:'crypto'}, {symbol:'ETH',spot:true,perp:true,priceDecimals:2,category:'crypto'},
  {symbol:'BNB',spot:true,perp:true,priceDecimals:2,category:'crypto'}, {symbol:'SOL',spot:true,perp:true,priceDecimals:2,category:'crypto'},
  {symbol:'XRP',spot:true,perp:true,priceDecimals:4,category:'crypto'}, {symbol:'DOGE',spot:true,perp:true,priceDecimals:5,category:'crypto'},
].map(item => ({
  ...item,
  logo:tradeMarketLogo(item),
    remoteLogo:marketRemoteLogo(item),
    fallbackLogo:marketFallbackLogo(item),
  }));
let tradeProduct = 'perp';
let tradeSymbol = 'BTC';
window.tradeProduct = tradeProduct;
window.tradeSymbol = tradeSymbol;
const initialTradeMarket = TRADE_MARKETS.find(item => item.symbol === tradeSymbol);
if ($('trade-symbol-logo') && initialTradeMarket) {
  bindMarketLogo($('trade-symbol-logo'), initialTradeMarket);
}

async function loadTradeMarkets() {
  const response = await fetch('/api/market/tokens');
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '读取代币目录失败');
  const next = (payload.tokens || []).map(item => ({
    ...item,
    symbol:String(item.symbol || '').toUpperCase(),
    category:item.category === 'stock' ? 'stock' : 'crypto',
  })).map(item => ({
    ...item,
    logo:tradeMarketLogo(item),
    remoteLogo:marketRemoteLogo(item),
    fallbackLogo:marketFallbackLogo(item),
  })).filter(item => item.symbol);
  if (!next.length) return;
  TRADE_MARKETS = next;
  if (!TRADE_MARKETS.some(item => item.symbol === tradeSymbol && item[tradeProduct] && marketInCurrentScope(item))) {
    tradeSymbol = TRADE_MARKETS.find(item => item[tradeProduct] && marketInCurrentScope(item))?.symbol || TRADE_MARKETS[0].symbol;
  }
  setTradeSymbol(tradeSymbol);
  renderTradeMarketList($('trade-market-search')?.value || '');
}

function marketInCurrentScope(item) {
  return tradeMarketScope === 'stock' ? item.category === 'stock' : item.category !== 'stock';
}

function tradePriceDecimalsFor(symbol, value) {
  const configured = TRADE_MARKETS.find(item => item.symbol === symbol)?.priceDecimals;
  if (Number.isInteger(configured)) return configured;
  const price = Math.abs(Number(value) || 0);
  if (price >= 100) return 2;
  if (price >= 1) return 3;
  if (price >= 0.01) return 5;
  return 8;
}
function tradePriceDecimals(value) { return tradePriceDecimalsFor(tradeSymbol, value); }
function formatTradePrice(value) {
  const decimals = tradePriceDecimals(value);
  return Number(value).toLocaleString('en-US', { minimumFractionDigits:decimals, maximumFractionDigits:decimals });
}
function formatTradeMarketPrice(symbol, value) {
  const decimals = tradePriceDecimalsFor(symbol, value);
  return Number(value).toLocaleString('en-US', { minimumFractionDigits:decimals, maximumFractionDigits:decimals });
}
function formatTradeTurnover(value, digits = 0) {
  return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits:digits, maximumFractionDigits:digits });
}
function formatTradeAmount(value) {
  // 交易所风格紧凑数量：<1k 全精度 / <100k 千分位2位 / 否则 K·M 缩写，保证横排不溢出
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return `${(n / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}M`;
  if (abs >= 100_000) return `${(n / 1_000).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}K`;
  if (abs >= 1_000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function applyTradeTickerSummary(summary) {
  if (!summary || summary.symbol !== tradeSymbol) return false;
  const change = Number(summary.changePercent);
  $('trade-change').textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
  $('trade-change').className = change >= 0 ? 'up' : 'down';
  $('trade-high').textContent = formatTradeMarketPrice(tradeSymbol, summary.highPrice);
  $('trade-low').textContent = formatTradeMarketPrice(tradeSymbol, summary.lowPrice);
  $('trade-volume').textContent = formatTradeTurnover(summary.quoteVolume, 2);
  return true;
}

function renderTradeMarketList(filter = '') {
  const query = String(filter).trim().toUpperCase();
  const favorites = window.TradeFavorites?.list() || [];
  const items = TRADE_MARKETS.filter(item=>item[tradeProduct] && marketInCurrentScope(item) && (!query || `${item.symbol}/USDT`.includes(query)) && (tradeMarketCategory !== 'favorites' || favorites.includes(item.symbol)));
  $('trade-market-list').innerHTML = items.map(item=>{
    const summary = tradeMarketSummaries.get(tradeMarketKey(tradeProduct, item.symbol));
    const priceText = summary?.price > 0 ? formatTradeMarketPrice(item.symbol, summary.price) : '—';
    const change = Number(summary?.changePercent);
    const changeText = Number.isFinite(change) ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '—';
    const volumeText = Number(summary?.quoteVolume) > 0 ? formatTradeTurnover(summary.quoteVolume) : '—';
    const star = window.TradeFavorites?.renderStar(item.symbol) || '';
    const pairTag = item.category === 'stock'
      ? (tradeProduct === 'spot' ? '股票现货' : '股票合约')
      : (tradeProduct === 'spot' ? '现货' : '合约');
    return `<div class="market-list-row${item.symbol===tradeSymbol?' active':''}" role="button" tabindex="0" data-market-symbol="${item.symbol}"><span class="market-pair">${star}<span class="market-list-logo"><img src="${item.logo}" alt="${item.symbol}" loading="lazy" onerror="if(!this.dataset.f){this.dataset.f=1;this.src='${item.remoteLogo||item.logo}'}else{this.onerror=null;this.src='${item.fallbackLogo}'}"></span><span>${item.symbol}/USDT <em>${pairTag}</em></span></span><strong data-price="${item.symbol}">${priceText}</strong><i class="${Number.isFinite(change)?(change>=0?'up':'down'):''}" data-change="${item.symbol}">${changeText}</i><small data-volume="${item.symbol}">${volumeText}</small></div>`;
  }).join('') || '<div class="terminal-empty">没有匹配的市场</div>';
  document.querySelectorAll('[data-market-symbol]').forEach(row=>{
    row.onclick = () => setTradeSymbol(row.dataset.marketSymbol);
    row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTradeSymbol(row.dataset.marketSymbol); } };
  });
  document.querySelectorAll('[data-favorite]').forEach(btn=>{
    btn.onclick = (e) => { e.stopPropagation(); window.TradeFavorites.toggle(btn.dataset.favorite); renderTradeMarketList($('trade-market-search')?.value || ''); };
  });
}

async function refreshTradeMarketOverview() {
  if (document.hidden || !$('tab-trade')?.classList.contains('active')) return;
  const product = tradeProduct;
  if (tradeMarketOverviewRequests.has(product)) return tradeMarketOverviewRequests.get(product);
  const request = (async () => {
    try {
      const response = await fetch(`/api/market/tickers?product=${product}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '市场概览读取失败');
      for (const item of payload.tickers || []) {
        tradeMarketSummaries.set(tradeMarketKey(product, item.symbol), item);
        if (product === tradeProduct) applyTradeTickerSummary(item);
      }
      if (product === tradeProduct) renderTradeMarketList($('trade-market-search')?.value || '');
    } catch (error) {
      console.warn('[trade] market overview temporarily unavailable:', error.message);
    }
  })();
  tradeMarketOverviewRequests.set(product, request);
  try { return await request; }
  finally { if (tradeMarketOverviewRequests.get(product) === request) tradeMarketOverviewRequests.delete(product); }
}

function setTradeSymbol(symbol) {
  if (!TRADE_MARKETS.some(item=>item.symbol===symbol && item[tradeProduct] && marketInCurrentScope(item))) return;
  tradeSymbol=symbol;
  window.tradeSymbol = symbol;
  // trade-chart.js 延迟加载，初始化阶段可能尚未定义
  if (typeof resetTradeHeaderPrices === 'function') resetTradeHeaderPrices();
  $('trade-symbol').textContent=`${symbol} / USDT`;
  const selectedMarket = TRADE_MARKETS.find(item => item.symbol === symbol);
  if ($('trade-symbol-logo') && selectedMarket) {
    bindMarketLogo($('trade-symbol-logo'), selectedMarket);
    $('trade-symbol-logo').alt = symbol;
  }
  updateTradeOrderAsset(); // 切币种后重算单位（现货买卖方向单位不同）
  $('trade-order-size').value='';
  $('trade-trigger-price').value='';
  $('trade-market-picker').hidden=true;
  tradeChartNeedsFit=true;
  renderTradeMarketList($('trade-market-search').value);
  updateTradeOrderButton();
  updateTradeMarketDetails();
  if (typeof updateTradeExecutionMarkers === 'function') updateTradeExecutionMarkers();
  refreshTradeTerminal(tradeIntervalSec);
  refreshTradeOrderBook();
  if (window.TradeBookTabs?.active === 'trades') window.TradeTrades?.refresh();
  loadPlatformProfile().catch(()=>{});
}

/**
 * 更新数量（trade-order-size）右列单位标签：
 *   - 现货买入：用户用 USDT 买币 → 输入框单位写 USDT（表示用户准备花多少 USDT）
 *   - 现货卖出：用户卖手里的币 → 单位写 tradeSymbol（BTC/ETH 等）
 *   - 永续合约：开仓/减仓数量都以基础资产计 → 单位永远是 tradeSymbol
 */
function updateTradeOrderAsset() {
  const side = document.querySelector('.side-switch button.active')?.dataset.side || 'buy';
  let asset = tradeSymbol;
  if (tradeProduct === 'spot' && side === 'buy') asset = 'USDT';
  const el = $('trade-order-asset');
  if (el) el.textContent = asset;
}

function setTradeProduct(product) {
  tradeProduct = product === 'spot' ? 'spot' : 'perp';
  window.tradeProduct = tradeProduct;
  // trade-chart.js 延迟加载，初始化阶段可能尚未定义
  if (typeof resetTradeHeaderPrices === 'function') resetTradeHeaderPrices();
  document.querySelectorAll('[data-market-product]').forEach(button => button.classList.toggle('active', button.dataset.marketProduct === tradeProduct));
  $('trade-symbol').textContent = `${tradeSymbol} / USDT`;
  $('trade-mark-price').textContent = '加载中';
  $('trade-order-price').value = '';
  $('trade-product-label').textContent = tradeProduct === 'spot' ? '现货' : '永续合约';
  $('trade-buy-label').textContent = tradeProduct === 'spot' ? '买入' : '做多';
  $('trade-sell-label').textContent = tradeProduct === 'spot' ? '卖出' : '做空';
  $('trade-available-label').textContent = tradeProduct === 'spot' ? '平台可用余额' : '平台可用保证金';
  $('trade-leverage-field').hidden = tradeProduct !== 'perp';
  $('trade-margin-mode-field').hidden = tradeProduct !== 'perp';
  $('trade-reduce-only-field').hidden = tradeProduct !== 'perp';
  $('trade-leverage-popover').hidden = true;
  $('trade-margin-popover').hidden = true;
  $('trade-leverage-trigger').setAttribute('aria-expanded', 'false');
  $('trade-margin-mode-trigger').setAttribute('aria-expanded', 'false');
  if (tradeProduct !== 'perp') syncReduceOnlyControl(false);
  syncLeverageControl($('trade-leverage').value);
  syncMarginModeControl($('trade-margin-mode').value);
  updateTradeMarketDetails();
  if (typeof updateTradeExecutionMarkers === 'function') updateTradeExecutionMarkers();
  updateTradeOrderPanel();
  renderTradeMarketList($('trade-market-search')?.value || '');
  refreshTradeMarketOverview();
  updateTradeOrderButton();
  renderTradeAccount();
  $('trade-asks').innerHTML = '';
  $('trade-bids').innerHTML = '';
  $('trade-book-mid').textContent = '加载中…';
  tradeChartNeedsFit = true;
  // 现货不显示合约持仓开仓价线：切换产品后先清除，再按当前模式重建（见 loadPlatformProfile）
  if (typeof updateTradeEntryPriceLine === 'function') updateTradeEntryPriceLine(0, '');
  if (window.currentWalletProfile?.authenticated) loadPlatformProfile().catch(() => {});
  refreshTradeTerminal(tradeIntervalSec);
  refreshTradeOrderBook();
  window.TradeFunding?.setProduct(tradeProduct);
}

async function refreshTradeTerminal(intervalSec = tradeIntervalSec) {
  if (document.hidden || !$('tab-trade')?.classList.contains('active')) return;
  tradeIntervalSec = intervalSec;
  const product = tradeProduct, symbol = tradeSymbol;
  const requestId = ++tradeMarketRequest;
  try {
    const response = await fetch(`/api/market/candles?product=${product}&symbol=${symbol}&intervalSec=${intervalSec}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'K 线读取失败');
    if (requestId !== tradeMarketRequest || product !== tradeProduct || symbol !== tradeSymbol) return;
    const raw = Array.isArray(payload.candles) ? payload.candles : [];
    const metrics = renderTradeChartCandles(raw);
    if (!metrics) return;
    const { last, high, low, change, volume } = metrics;
    const latestTick = tradeLatestTicks.get(tradeMarketKey(product, symbol));
    if (latestTick?.price > 0) applyTradeLivePrice(latestTick.price, latestTick.receivedAt);
    const payloadMark = Number(payload.markPrice);
    const latestMark = tradeLatestMarks.get(tradeMarketKey(product, symbol));
    const markPrice = latestMark?.price > 0 ? latestMark.price : (payloadMark > 0 ? payloadMark : last.close);
    applyTradeMarkPrice(markPrice);
    const displayPrice = latestTick?.price > 0 ? latestTick.price : last.close;
    const summary = tradeMarketSummaries.get(tradeMarketKey(product, symbol));
    if (!applyTradeTickerSummary(summary)) {
      $('trade-change').textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
      $('trade-change').className = change >= 0 ? 'up' : 'down';
      $('trade-high').textContent = formatTradePrice(high);
      $('trade-low').textContent = formatTradePrice(low);
      $('trade-volume').textContent = formatTradeTurnover(volume * displayPrice, 2);
    }
    document.querySelector(`[data-price="${symbol}"]`)?.replaceChildren(formatTradePrice(displayPrice));
    const changeCell=document.querySelector(`[data-change="${symbol}"]`); if(changeCell){changeCell.textContent=`${change>=0?'+':''}${change.toFixed(2)}%`;changeCell.className=change>=0?'up':'down';}
    if (tradeOrderType !== 'limit' || !$('trade-order-price').value) $('trade-order-price').value = displayPrice.toFixed(tradePriceDecimals(displayPrice));
    updateTradeOrderPanel();
    updateTradeMarketDetails();
    refreshTradeOrderBook();
  } catch (error) {
    console.error('[trade] market refresh failed:', error.message);
    $('trade-mark-price').textContent = '行情不可用';
    $('trade-high').textContent = '—'; $('trade-low').textContent = '—'; $('trade-change').textContent = '—';
  }
}

function initTradeMarketStream() {
  tradeMarketStream?.close();
  if (document.hidden || !$('tab-trade')?.classList.contains('active')) return;
  const streamProduct = tradeProduct;
  tradeMarketStream = new EventSource(`/api/market/stream?product=${streamProduct}`);
  tradeMarketStream.onmessage = (event) => {
    try {
      if (streamProduct !== tradeProduct) return;
      const update = JSON.parse(event.data);
      const updateSymbol = String(update.symbol || '').toUpperCase().replace(/USDT$/, '');
      const receivedAt = Number(update.receivedAt || update.eventTime) || Date.now();
      const key = tradeMarketKey(streamProduct, updateSymbol);
      const isMark = streamProduct === 'perp' && update.priceType === 'mark';
      const target = isMark ? tradeLatestMarks : tradeLatestTicks;
      const previous = target.get(key);
      if (previous && receivedAt < previous.receivedAt) return;
      target.set(key, { price:Number(update.price), receivedAt });
      if (isMark) {
        if (updateSymbol === tradeSymbol) applyTradeMarkPrice(update.price);
        return;
      }
      const summary = tradeMarketSummaries.get(key) || {};
      tradeMarketSummaries.set(key, { ...summary, symbol:updateSymbol, price:Number(update.price) });
      const rowPrice = document.querySelector(`[data-price="${updateSymbol}"]`);
      if (rowPrice && Number(update.price) > 0) rowPrice.textContent = formatTradeMarketPrice(updateSymbol, update.price);
      if (streamProduct === 'perp') {
        const latestMark = tradeLatestMarks.get(key);
        if (!latestMark || receivedAt - latestMark.receivedAt > 2_500) {
          updatePlatformPerpMark(updateSymbol, update.price);
        }
      }
      const matchesProduct = update.symbol === tradeSymbol || update.symbol === `${tradeSymbol}USDT`;
      if (matchesProduct) applyTradeLivePrice(update.price, receivedAt);
    } catch { /* a malformed tick must not stop the stream */ }
  };
  // SSE 断线后自动重连（浏览器默认重连间隔 3 秒，这里加上手动重连兜底）
  tradeMarketStream.onerror = () => {
    try { tradeMarketStream.close(); } catch {}
    setTimeout(() => {
      if (streamProduct === tradeProduct) initTradeMarketStream();
    }, 3000);
  };
}

function tradeOpeningQuantity(size, side) {
  if (tradeProduct !== 'perp' || $('trade-reduce-only')?.checked) return 0;
  const position = platformProfile?.perps?.[tradeSymbol] || platformProfile?.perp || {};
  const currentSize = Number(position.size) || 0;
  const delta = side === 'sell' ? -size : size;
  if (!currentSize || Math.sign(currentSize) === Math.sign(delta)) return size;
  return Math.max(0, size - Math.abs(currentSize));
}

function normalizeTradeLeverage(value) {
  return Math.min(100, Math.max(1, Math.trunc(Number(value) || 1)));
}

function syncLeverageControl(value) {
  const leverage = normalizeTradeLeverage(value);
  if ($('trade-leverage')) $('trade-leverage').value = String(leverage);
  if ($('trade-leverage-trigger')) $('trade-leverage-trigger').textContent = `${leverage}x`;
  document.querySelectorAll('[data-leverage-value]').forEach(button => button.classList.toggle('active', Number(button.dataset.leverageValue) === leverage));
  return leverage;
}

function syncMarginModeControl(value) {
  const mode = value === 'cross' ? 'cross' : 'isolated';
  if ($('trade-margin-mode')) $('trade-margin-mode').value = mode;
  if ($('trade-margin-mode-trigger')) $('trade-margin-mode-trigger').textContent = mode === 'cross' ? '全仓' : '逐仓';
  document.querySelectorAll('[data-margin-mode]').forEach(button => button.classList.toggle('active', button.dataset.marginMode === mode));
  return mode;
}

function syncReduceOnlyControl(checked) {
  const active = Boolean(checked);
  if ($('trade-reduce-only')) $('trade-reduce-only').checked = active;
  $('trade-reduce-only-toggle')?.setAttribute('aria-checked', String(active));
  return active;
}

function positionTradePopover(popover, field) {
  popover.style.top = `${field.offsetTop + field.offsetHeight + 3}px`;
}

function tradeEstimatePrice() {
  if (tradeOrderType === 'trigger') return Number($('trade-trigger-price')?.value) || Number($('trade-order-price').value) || 0;
  return Number($('trade-order-price').value) || 0;
}

function updateTradeMarketDetails() {
  const copy = (source, target) => { if ($(source) && $(target)) $(target).textContent = $(source).textContent; };
  if ($('trade-detail-symbol')) $('trade-detail-symbol').textContent = `${tradeSymbol}/USDT`;
  if ($('trade-detail-product')) $('trade-detail-product').textContent = tradeProduct === 'spot' ? '现货' : 'USDT 永续';
  copy('trade-mark-price', 'trade-detail-price');
  copy('trade-change', 'trade-detail-change');
  copy('trade-high', 'trade-detail-high');
  copy('trade-low', 'trade-detail-low');
  copy('trade-volume', 'trade-detail-volume');
  const change = $('trade-detail-change');
  if (change) change.className = $('trade-change')?.className || '';
}

function setTradeChartView(view) {
  const next = view === 'details' ? 'details' : 'chart';
  document.querySelectorAll('#trade-chart-tabs button').forEach(button => button.classList.toggle('active', button.dataset.chartView === next));
  $('trade-chart').hidden = next !== 'chart';
  $('trade-indicators').hidden = next !== 'chart';
  $('trade-chart-details').hidden = next !== 'details';
  if (next === 'details') updateTradeMarketDetails();
  if (next === 'chart') setTimeout(() => { if (typeof snapTradeChartToLatest === 'function') snapTradeChartToLatest(); else tradeChart?.timeScale().fitContent(); }, 20);
}

function setTradeIndicator(period, visible = !tradeMaVisibility.get(period)) {
  tradeMaVisibility.set(period, visible);
  tradeMaSeries.get(period)?.applyOptions({ visible });
  document.querySelectorAll(`#trade-indicators .indicator-toggle:not([data-indicator])[data-period="${period}"], [data-indicator-period="${period}"]`).forEach(button => button.classList.toggle('active', visible));
  document.querySelector(`[data-indicator-period="${period}"] b`)?.replaceChildren(visible ? '开启' : '关闭');
}

function updateTradeOrderPanel() {
  updateTradeOrderAsset(); // 先同步数量单位（买卖方向切换后第一时间改）
  const context = typeof availableTradeContext === 'function'
    ? availableTradeContext()
    : { amount:0, asset:'USDT', label:'平台可用余额' };
  const availableText = `${formatTradeAmount(context.amount)} ${context.asset}`;
  $('trade-available-label').textContent = context.label;
  $('trade-available-balance').textContent = availableText;
  $('trade-summary-available-label').textContent = context.label;
  $('trade-summary-available').textContent = availableText;

  const price = tradeEstimatePrice();
  const side = document.querySelector('.side-switch button.active')?.dataset.side || 'buy';
  const rawSize = Number($('trade-order-size').value) || 0;
  // 现货买入：输入框写 USDT 金额，因此 notional=rawSize，基础资产 size=USDT 金额 / (价*1.0005)
  // 其他场景：rawSize 本身就是基础资产数量，notional=price*size
  let notional = 0, size = 0, receiveQty = 0, receiveAsset = '', receiveLabel = '';
  if (tradeProduct === 'spot' && side === 'buy') {
    notional = rawSize;
    size = price > 0 ? rawSize / (price * 1.0005) : 0;
    receiveQty = size;
    receiveAsset = tradeSymbol;
    receiveLabel = `获得 ${tradeSymbol}`;
  } else if (tradeProduct === 'spot' && side === 'sell') {
    size = rawSize;
    notional = price * size;
    receiveQty = notional;
    receiveAsset = 'USDT';
    receiveLabel = '获得 USDT';
  } else {
    size = rawSize;
    notional = price * size;
    receiveQty = size;
    receiveAsset = tradeSymbol;
    receiveLabel = $('trade-reduce-only')?.checked ? `减少仓位 ${tradeSymbol}` : `开仓数量 ${tradeSymbol}`;
  }
  $('trade-order-value').textContent = `${notional.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })} USDT`;

  // 新摘要行：获得数量/开仓数量/减少仓位数量，用户能直观看出"买多少 USDT → 到手多少币"
  const receiveLabelEl = $('trade-receive-label');
  const receiveQtyEl = $('trade-receive-qty');
  if (receiveLabelEl && receiveQtyEl) {
    receiveLabelEl.textContent = receiveLabel;
    if (receiveQty > 0) {
      receiveQtyEl.textContent = `${formatTradeAmount(receiveQty)} ${receiveAsset}`;
    } else if (String($('trade-order-size').value).trim().length === 0) {
      receiveQtyEl.textContent = `— ${receiveAsset}`;
    } else {
      receiveQtyEl.textContent = `— ${receiveAsset}`;
    }
  }

  const isPerp = tradeProduct === 'perp';
  const openingSize = tradeOpeningQuantity(size, side);
  const position = platformProfile?.perps?.[tradeSymbol] || platformProfile?.perp || {};
  const sameDirection = Number(position.size) && Math.sign(Number(position.size)) === (side === 'sell' ? -1 : 1);
  const leverage = sameDirection ? normalizeTradeLeverage(position.leverage) : normalizeTradeLeverage($('trade-leverage').value);
  const openingNotional = price * openingSize;
  $('trade-opening-size-row').hidden = !isPerp;
  $('trade-opening-size').textContent = `${formatTradeAmount(openingSize)} ${tradeSymbol}`;
  $('trade-opening-margin-row').hidden = !isPerp;
  $('trade-fee-row').hidden = !isPerp;
  $('trade-opening-margin').textContent = `${(openingNotional / Math.max(1, leverage)).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:6 })} USDT`;
  $('trade-fee').textContent = `${(notional * 0.0004).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:6 })} USDT`;
}

function applyTradeAmountSlider(percent) {
  const price = tradeEstimatePrice();
  const context = typeof availableTradeContext === 'function' ? availableTradeContext() : { amount:0, asset:'USDT' };
  const ratio = Math.min(100, Math.max(0, Number(percent) || 0)) / 100;
  document.querySelectorAll('[data-amount-percent]').forEach(button => button.classList.toggle('active', Number(button.dataset.amountPercent) === ratio * 100));
  updateTradeOrderAsset();
  const side = document.querySelector('.side-switch button.active')?.dataset.side || 'buy';
  let out = 0;
  if (tradeProduct === 'spot' && side === 'sell') {
    // 现货卖出：单位=tradeSymbol，滑块按余额(已在 context.asset=tradeSymbol)比例填 BTC 数量
    out = context.amount * ratio;
  } else if (tradeProduct === 'perp' && $('trade-reduce-only').checked) {
    out = context.amount * ratio;
  } else if (price > 0 && tradeProduct === 'perp') {
    const position = platformProfile?.perps?.[tradeSymbol] || platformProfile?.perp || {};
    const sameDirection = Number(position.size) && Math.sign(Number(position.size)) === (side === 'sell' ? -1 : 1);
    const leverage = sameDirection ? normalizeTradeLeverage(position.leverage) : normalizeTradeLeverage($('trade-leverage').value);
    out = context.amount * ratio / (price * (1 / Math.max(1, leverage) + 0.0004));
  } else {
    // 现货买入：context.amount=USDT，input 单位也写 USDT → 直接比例乘 USDT 金额
    // 兜底：其他 price=0 场景
    out = context.amount * ratio;
  }
  const roundedDown = Math.floor(Math.max(0, out) * 1e8) / 1e8;
  $('trade-order-size').value = roundedDown > 0 ? roundedDown.toFixed(8).replace(/0+$/, '').replace(/\.$/, '') : '';
  updateTradeOrderPanel();
}

function initTradeTerminal() {
  $('trade-price-mode').addEventListener('change', (event) => setTradeHeaderPriceMode(event.target.value));
  const picker = $('trade-market-picker');
  $('trade-market-trigger').onclick = () => {
    picker.hidden = false;
    renderTradeMarketList($('trade-market-search').value);
    refreshTradeMarketOverview();
    $('trade-market-search').focus();
  };
  $('trade-market-close').onclick = () => { picker.hidden = true; };
  picker.onclick = (event) => { if (event.target === picker) picker.hidden = true; };
  document.querySelectorAll('[data-market-product]').forEach(button => button.onclick = () => {
    tradeMarketCategory = 'product';
    const targetProduct = button.dataset.marketProduct;
    // 股票范围内切换现货/合约：保持股票过滤，切到同产品的股票
    if (tradeMarketScope === 'stock') {
      document.querySelectorAll('[data-market-product],[data-market-category]').forEach(item => item.classList.toggle('active', item === button));
      document.querySelectorAll('[data-market-scope]').forEach(item => item.classList.add('active'));
      const current = TRADE_MARKETS.find(item => item.symbol === tradeSymbol);
      if (current?.category === 'stock' && current?.[targetProduct]) {
        setTradeProduct(targetProduct);
      } else {
        const next = TRADE_MARKETS.find(item => item.category === 'stock' && item[targetProduct]);
        setTradeProduct(targetProduct);
        if (next) setTradeSymbol(next.symbol);
      }
      initTradeMarketStream();
      renderTradeMarketList($('trade-market-search')?.value || '');
      refreshTradeMarketOverview();
      return;
    }
    setTradeMarketScope('crypto');
    document.querySelectorAll('[data-market-product],[data-market-category],[data-market-scope]').forEach(item => item.classList.toggle('active', item === button));
    // 从股票范围切回加密币种时，若当前选中的是股票，自动切到该产品的第一个加密市场
    const current = TRADE_MARKETS.find(item => item.symbol === tradeSymbol);
    if (current?.category === 'stock' || !current?.[targetProduct]) {
      const next = TRADE_MARKETS.find(item => item.category !== 'stock' && item[targetProduct]);
      setTradeProduct(targetProduct);
      if (next) setTradeSymbol(next.symbol);
      initTradeMarketStream();
      return;
    }
    setTradeProduct(targetProduct);
    initTradeMarketStream();
  });
  document.querySelectorAll('[data-market-scope]').forEach(button => button.onclick = () => {
    tradeMarketCategory = 'product';
    setTradeMarketScope('stock');
    document.querySelectorAll('[data-market-product],[data-market-category],[data-market-scope]').forEach(item => {
      item.classList.toggle('active', item === button || (item.matches('[data-market-product]') && item.dataset.marketProduct === tradeProduct));
    });
    const current = TRADE_MARKETS.find(item => item.symbol === tradeSymbol);
    if (current?.category !== 'stock') {
      const firstStock = TRADE_MARKETS.find(item => item.category === 'stock' && item[tradeProduct]);
      if (firstStock) setTradeSymbol(firstStock.symbol);
      else renderTradeMarketList($('trade-market-search')?.value || '');
    } else {
      renderTradeMarketList($('trade-market-search')?.value || '');
    }
    refreshTradeMarketOverview();
  });
  document.querySelectorAll('[data-market-category]').forEach(button => button.onclick = () => {
    tradeMarketCategory = 'favorites';
    setTradeMarketScope('crypto');
    document.querySelectorAll('[data-market-product],[data-market-category],[data-market-scope]').forEach(item => item.classList.toggle('active', item === button));
    renderTradeMarketList($('trade-market-search')?.value || '');
  });
  window.TradeBookTabs?.init();
  window.TradeFunding?.setProduct(tradeProduct);
  initOrderBookClick();
  $('trade-book-precision')?.addEventListener('change', () => refreshTradeOrderBook());
  $('trade-alert-btn')?.addEventListener('click', () => {
    const midText = $('trade-book-mid')?.querySelector('.book-mid-price')?.textContent || $('trade-book-mid')?.textContent || '';
    const price = Number(midText.replace(/[$,]/g, '') || 0);
    window.TradeAlerts?.openDialog(tradeSymbol, price);
  });
  $('trade-market-search').addEventListener('input', (event) => {
    renderTradeMarketList(event.target.value);
  });
  document.querySelectorAll('#trade-account-tabs button').forEach(button => button.onclick = () => {
    tradeAccountView = button.dataset.view;
    document.querySelectorAll('#trade-account-tabs button').forEach(item => item.classList.toggle('active', item === button));
    renderTradeAccount();
  });
  document.querySelectorAll('#trade-chart-tabs button').forEach(button => button.onclick = () => setTradeChartView(button.dataset.chartView));
  $('trade-timeframes').querySelectorAll('button').forEach(button => button.onclick = () => {
    $('trade-timeframes').querySelectorAll('button').forEach(item => item.classList.toggle('active', item === button));
    tradeChartNeedsFit = true;
    refreshTradeTerminal(Number(button.dataset.sec));
  });
  document.querySelectorAll('#trade-indicators .indicator-toggle').forEach(button => button.onclick = () => {
    const ind = button.dataset.indicator;
    if (ind === 'ema') setTradeEma(Number(button.dataset.period));
    else if (ind === 'boll') setTradeBoll();
    else if (ind === 'vol') setTradeVol();
    else if (ind === 'macd') setTradeMacd();
    else setTradeIndicator(Number(button.dataset.period));
  });
  document.querySelectorAll('[data-indicator-period]').forEach(button => button.onclick = () => {
    const key = button.dataset.indicatorPeriod;
    if (key.startsWith('ema-')) setTradeEma(Number(key.slice(4)));
    else if (key === 'boll') setTradeBoll();
    else if (key === 'vol') setTradeVol();
    else if (key === 'macd') setTradeMacd();
    else setTradeIndicator(Number(key));
  });
  document.querySelectorAll('.side-switch button').forEach(button => button.onclick = () => {
    document.querySelectorAll('.side-switch button').forEach(item => item.classList.toggle('active', item === button));
    updateTradeOrderButton();
    updateTradeOrderPanel();
  });
  $('trade-reduce-only').addEventListener('change', () => {
    updateTradeOrderButton();
    updateTradeOrderPanel();
  });
  // 可用余额点击填满数量（币安式交互）
  $('trade-available-balance')?.addEventListener('click', () => applyTradeAmountSlider(100));
  document.querySelectorAll('#trade-order-types button').forEach(button => button.onclick = () => {
    tradeOrderType = button.dataset.orderType;
    document.querySelectorAll('#trade-order-types button').forEach(item => item.classList.toggle('active', item === button));
    $('trade-order-price').readOnly = tradeOrderType !== 'limit';
    $('trade-order-price').parentElement.querySelector('span').textContent = '价格';
    $('trade-order-price-field').hidden = tradeOrderType === 'trigger';
    $('trade-trigger-fields').hidden = tradeOrderType !== 'trigger';
    $('trade-tif-field').hidden = tradeOrderType !== 'limit';
    if (tradeOrderType !== 'limit') $('trade-order-price').value = Number(tradeLastPrice) > 0 ? Number(tradeLastPrice).toFixed(tradePriceDecimals(tradeLastPrice)) : '';
    if (tradeOrderType === 'trigger' && !$('trade-trigger-price').value && Number(tradeLastPrice) > 0) $('trade-trigger-price').value = Number(tradeLastPrice).toFixed(tradePriceDecimals(tradeLastPrice));
    updateTradeOrderButton();
    updateTradeOrderPanel();
  });
  $('trade-order-price').addEventListener('input', updateTradeOrderPanel);
  $('trade-order-size').addEventListener('input', updateTradeOrderPanel);
  $('trade-trigger-price').addEventListener('input', updateTradeOrderPanel);
  $('trade-trigger-direction').addEventListener('change', updateTradeOrderPanel);
  $('trade-leverage').addEventListener('input', () => {
    const rawLeverage = Number($('trade-leverage').value);
    if (Number.isFinite(rawLeverage) && rawLeverage > 100) $('trade-leverage').value = '100';
    else if (Number.isFinite(rawLeverage) && rawLeverage < 1) $('trade-leverage').value = '1';
    syncLeverageControl($('trade-leverage').value);
    const percent = Number(document.querySelector('.amount-slider').value) || 0;
    if (percent > 0) applyTradeAmountSlider(percent);
    else updateTradeOrderPanel();
  });
  $('trade-leverage').addEventListener('change', () => {
    syncLeverageControl($('trade-leverage').value);
    updateTradeOrderPanel();
  });
  $('trade-leverage-trigger').addEventListener('click', () => {
    const popover = $('trade-leverage-popover');
    positionTradePopover(popover, $('trade-leverage-field'));
    popover.hidden = !popover.hidden;
    $('trade-leverage-trigger').setAttribute('aria-expanded', String(!popover.hidden));
    $('trade-margin-popover').hidden = true;
  });
  document.querySelectorAll('[data-leverage-value]').forEach(button => button.onclick = () => {
    syncLeverageControl(button.dataset.leverageValue);
    $('trade-leverage-popover').hidden = true;
    $('trade-leverage-trigger').setAttribute('aria-expanded', 'false');
    const percent = Number(document.querySelector('.amount-slider').value) || 0;
    if (percent > 0) applyTradeAmountSlider(percent); else updateTradeOrderPanel();
  });
  $('trade-margin-mode-trigger').addEventListener('click', () => {
    const popover = $('trade-margin-popover');
    positionTradePopover(popover, $('trade-margin-mode-field'));
    popover.hidden = !popover.hidden;
    $('trade-margin-mode-trigger').setAttribute('aria-expanded', String(!popover.hidden));
    $('trade-leverage-popover').hidden = true;
  });
  document.querySelectorAll('[data-margin-mode]').forEach(button => button.onclick = () => {
    syncMarginModeControl(button.dataset.marginMode);
    $('trade-margin-popover').hidden = true;
    $('trade-margin-mode-trigger').setAttribute('aria-expanded', 'false');
    updateTradeOrderPanel();
  });
  $('trade-reduce-only-field').addEventListener('click', event => {
    event.preventDefault();
    syncReduceOnlyControl(!$('trade-reduce-only').checked);
    updateTradeOrderButton();
    updateTradeOrderPanel();
  });
  document.querySelector('.amount-slider').addEventListener('input', event => applyTradeAmountSlider(event.target.value));
  document.querySelectorAll('[data-amount-percent]').forEach(button => button.onclick = () => {
    const percent = Number(button.dataset.amountPercent) || 0;
    document.querySelector('.amount-slider').value = String(percent);
    document.querySelectorAll('[data-amount-percent]').forEach(item => item.classList.toggle('active', item === button));
    applyTradeAmountSlider(percent);
  });
  setTradeProduct('spot');
  loadTradeMarkets().catch(error => console.error('[trade] token catalog:', error.message));
  loadPlatformProfile().catch(() => {});
  initTradeMarketStream();
  refreshTradeMarketOverview();
  setInterval(() => { if (!document.hidden) refreshTradeTerminal(); }, 5_000);
  setInterval(() => { if (!document.hidden) { refreshTradeOrderBook(); if (window.TradeBookTabs?.active === 'trades') window.TradeTrades?.refresh(); } }, 1000);
  setInterval(() => { if (!document.hidden && !$('trade-market-picker').hidden) refreshTradeMarketOverview(); }, 15_000);
}

// 交易终端依赖首屏后懒加载批次中的脚本（trade-account.js 定义的 tradeOrderType/platformProfile/
// loadPlatformProfile 等）。core.js 是 defer、在 DOMContentLoaded 前执行，立即初始化会落入这些
// let 绑定的暂时性死区而抛 ReferenceError 并中断。改为由 index.html 加载器在批次全部执行完后调用。
function startTradeTerminal() {
  try { initTradeTerminal(); } catch (error) { console.error('[交易终端初始化]', error); }
}
if (window.__tradeDeferredReady) startTradeTerminal();
else window.__startTradeTerminal = startTradeTerminal;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) tradeMarketStream?.close();
  else if (window.__tradeDeferredReady && $('tab-trade')?.classList.contains('active')) {
    initTradeMarketStream();
    refreshTradeTerminal();
  }
});

let ledgerOffset = 0;
const ledgerLimit = 100;
const ledgerExchangeName = { de:'Decibel', ex:'Extended', rs:'RISEx' };
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
