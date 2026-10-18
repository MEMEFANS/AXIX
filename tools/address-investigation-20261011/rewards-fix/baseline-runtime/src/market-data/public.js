// Binance public BTC/USDT market data. No API key is required.
// Prices, candles and order books come from Binance Spot;
// order execution and balances remain simulated by each paper adapter.
import { Agent, fetch as undiciFetch, WebSocket } from 'undici';

export const PUBLIC_MARKET_DATA_REST = 'https://data-api.binance.vision';
export const PUBLIC_MARKET_DATA_WS = 'wss://stream.binance.com:9443/ws';
export const FUTURES_MARKET_DATA_REST = 'https://fapi.binance.com';
export const FUTURES_MARKET_DATA_WS = 'wss://fstream.binance.com/ws';
export const PUBLIC_MARKET_DATA_PROVIDER = 'binance-public';
export const PUBLIC_MARKET_DATA_LABEL = '币安公共行情';

const INTERVALS = new Map([
  [60, '1m'], [300, '5m'], [900, '15m'], [1800, '30m'],
  [3600, '1h'], [7200, '2h'], [14400, '4h'], [86400, '1d'],
]);
const PRICE_CACHE_TTL_MS = 1000;
const CANDLE_CACHE_TTL_MS = 30_000;
const ORDER_BOOK_CACHE_TTL_MS = 800;
const ORDER_BOOK_STALE_MS = 10_000;
const TRADES_CACHE_TTL_MS = 800;
const priceCache = new Map();
const candleCache = new Map();
const orderBookCache = new Map();
const tradesCache = new Map();
const sharedPriceStreams = new Map();

// --- 币安公共行情：直连 / 全局代理 自适应 ---
// 生产香港机房直连币安公共行情域名(data-api.binance.vision、fapi.binance.com、*.binance.com)延迟极低且稳定，
// 而 setupProxies 设置的全局 dispatcher 一旦不可用，会让行情/K线请求全部超时并高频重连。
// 因此行情层默认直连：连续失败自动回退到全局 dispatcher，并周期性回探直连、恢复后自动切回。
// 机房必须经代理才能访问币安时，设置环境变量 BINANCE_MARKET_DIRECT=0 即可完全跟随全局代理（旧行为）。
const FORCE_MARKET_PROXY = process.env.BINANCE_MARKET_DIRECT === '0';
let marketDirectAgent = null;
function marketDirectDispatcher() {
  if (!marketDirectAgent) {
    marketDirectAgent = new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 120_000, connections: 16 });
  }
  return marketDirectAgent;
}
let marketRoute = FORCE_MARKET_PROXY ? 'proxy' : 'direct'; // 'direct' | 'proxy'
let marketDirectFailures = 0;
let marketProxySince = 0;
const MARKET_DIRECT_FAIL_LIMIT = 2;
const MARKET_REPROBE_MS = 60_000;
function marketDispatcher() {
  if (FORCE_MARKET_PROXY) return null;                 // 显式要求跟随全局(可能是代理)
  if (marketRoute === 'direct') return marketDirectDispatcher();
  if (Date.now() - marketProxySince >= MARKET_REPROBE_MS) return marketDirectDispatcher(); // 代理期定期回探直连
  return null;
}
export async function marketFetch(url, init = {}) {
  const dispatcher = marketDispatcher();
  if (!dispatcher) return undiciFetch(url, init);     // 走全局 dispatcher
  try {
    const response = await undiciFetch(url, { ...init, dispatcher });
    marketDirectFailures = 0;
    if (marketRoute !== 'direct') { marketRoute = 'direct'; console.warn('[币安行情] 直连已恢复，切回直连'); }
    return response;
  } catch (error) {
    if (marketRoute === 'direct') {
      marketDirectFailures += 1;
      if (marketDirectFailures >= MARKET_DIRECT_FAIL_LIMIT) {
        marketRoute = 'proxy';
        marketProxySince = Date.now();
        console.warn('[币安行情] 直连连续失败，临时回退全局代理: ' + (error?.message || error));
      }
    } else {
      marketProxySince = Date.now();                  // 直连回探失败，稍后再试
    }
    throw error;
  }
}
export function marketWsDispatcher() {
  // 与 REST 共用同一自适应选择；返回 null 时由 undici 跟随全局 dispatcher。
  return marketDispatcher();
}

export class PublicPriceStream {
  constructor(baseSymbols, options = {}) {
    this.symbols = [...new Set(baseSymbols.map(toPublicMarketSymbol))].sort();
    if (!this.symbols.length) throw new Error('WebSocket 行情至少需要一个交易对');
    this.WebSocketImpl = options.WebSocketImpl || WebSocket;
    this.wsUrl = options.wsUrl || PUBLIC_MARKET_DATA_WS;
    this.product = options.product === 'perp' ? 'perp' : 'spot';
    this.priceType = options.priceType === 'trade' ? 'trade' : (this.product === 'perp' ? 'mark' : 'trade');
    this.minEmitMs = Math.max(options.minEmitMs == null ? 100 : Number(options.minEmitMs), 0);
    this.staleMs = Math.max(Number(options.staleMs) || 15000, 1000);
    this.connectTimeoutMs = Math.max(Number(options.connectTimeoutMs) || 10000, 1000);
    this.priceListeners = new Set();
    this.statusListeners = new Set();
    this.pending = new Map();
    this.socket = null;
    this.active = false;
    this.reconnectAttempt = 0;
    this.lastMessageAt = null;
    this.lastMessageBySymbol = new Map();
    this.connectedAt = null;
    this.state = 'stopped';
    this.message = '实时行情未启动';
    this._reconnectTimer = null;
    this._connectTimer = null;
    this._flushTimer = null;
    this._heartbeatTimer = null;
  }

  subscribe(onPrice, onStatus) {
    if (typeof onPrice === 'function') this.priceListeners.add(onPrice);
    if (typeof onStatus === 'function') {
      this.statusListeners.add(onStatus);
      onStatus(this.getStatus());
    }
    this.start();
    return () => {
      if (typeof onPrice === 'function') this.priceListeners.delete(onPrice);
      if (typeof onStatus === 'function') this.statusListeners.delete(onStatus);
    };
  }

  get listenerCount() { return this.priceListeners.size + this.statusListeners.size; }

  getStatus() {
    return {
      state: this.state,
      message: this.message,
      lastMessageAt: this.lastMessageAt,
      reconnectAttempt: this.reconnectAttempt,
      transport: 'websocket',
      staleSymbols: this._staleSymbols(),
    };
  }

  start() {
    if (this.active) return;
    this.active = true;
    const flushEvery = Math.max(this.minEmitMs, 25);
    this._flushTimer = setInterval(() => this._flush(), flushEvery);
    this._flushTimer.unref?.();
    this._heartbeatTimer = setInterval(() => this._heartbeat(), 5000);
    this._heartbeatTimer.unref?.();
    this._connect();
  }

  reconnect() {
    if (!this.active) { this.start(); return; }
    this.reconnectAttempt = 0;
    this.connectedAt = null;
    this.lastMessageBySymbol.clear();
    this._clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(4000, 'manual reconnect'); } catch { /* best effort */ }
    this._setStatus('connecting', '正在重新连接币安 WebSocket');
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, 0);
    this._reconnectTimer.unref?.();
  }

  close() {
    this.active = false;
    this._clearReconnectTimer();
    if (this._connectTimer) clearTimeout(this._connectTimer);
    if (this._flushTimer) clearInterval(this._flushTimer);
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._connectTimer = this._flushTimer = this._heartbeatTimer = null;
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(1000, 'no subscribers'); } catch { /* best effort */ }
    this.pending.clear();
    this.lastMessageBySymbol.clear();
    this.connectedAt = null;
    this._setStatus('stopped', '实时行情已停止');
  }

  _connect() {
    if (!this.active || this.socket) return;
    this._setStatus(this.reconnectAttempt ? 'reconnecting' : 'connecting', '正在连接币安 WebSocket');
    let socket;
    try {
      // 币安行情 WS 默认随 REST 一同直连（marketWsDispatcher 返回直连 dispatcher）；
      // 返回 null（强制代理或回退期）时不传，由 undici 跟随全局 dispatcher。
      const wsOptions = {};
      const wsDispatcher = marketWsDispatcher();
      if (wsDispatcher) wsOptions.dispatcher = wsDispatcher;
      socket = new this.WebSocketImpl(this.wsUrl, wsOptions);
    } catch (error) {
      this._scheduleReconnect(error);
      return;
    }
    this.socket = socket;
    this._connectTimer = setTimeout(() => {
      try { socket.close(4000, 'connect timeout'); } catch { /* close event will reconnect */ }
    }, this.connectTimeoutMs);
    this._connectTimer.unref?.();

    socket.addEventListener('open', () => {
      if (socket !== this.socket || !this.active) return;
      if (this._connectTimer) clearTimeout(this._connectTimer);
      this._connectTimer = null;
      this.connectedAt = Date.now();
      const suffix = this.product === 'perp' && this.priceType === 'mark' ? '@markPrice@1s' : '@trade';
      socket.send(JSON.stringify({ method:'SUBSCRIBE', params:this.symbols.map(symbol => `${symbol.toLowerCase()}${suffix}`), id:Date.now() }));
      this._setStatus('connecting', '已连接，等待币安实时价格');
    });

    socket.addEventListener('message', (event) => {
      if (socket !== this.socket || !this.active) return;
      void this._handleMessage(event.data);
    });

    socket.addEventListener('error', (event) => {
      if (socket !== this.socket || !this.active) return;
      this.message = event?.message || '币安 WebSocket 连接异常';
    });

    socket.addEventListener('close', () => {
      if (socket !== this.socket) return;
      if (this._connectTimer) clearTimeout(this._connectTimer);
      this._connectTimer = null;
      this.socket = null;
      if (this.active) this._scheduleReconnect(new Error(this.message || 'WebSocket 已断开'));
    });
  }

  async _handleMessage(raw) {
    const text = await decodeWebSocketData(raw);
    const updates = parsePublicPriceMessages(text).filter((update) => this.symbols.includes(update.symbol));
    if (!updates.length) return;
    this.lastMessageAt = Date.now();
    this.reconnectAttempt = 0;
    if (this.state !== 'live') this._setStatus('live', '币安 WebSocket 实时行情');
    for (const update of updates) {
      this.lastMessageBySymbol.set(update.symbol, this.lastMessageAt);
      const priceType = update.priceType || this.priceType;
      this.pending.set(`${update.symbol}:${priceType}`, { ...update, priceType, product:this.product, receivedAt: this.lastMessageAt });
    }
    if (this.minEmitMs === 0) this._flush();
  }

  _flush() {
    if (!this.pending.size) return;
    const updates = [...this.pending.values()];
    this.pending.clear();
    for (const update of updates) {
      for (const listener of this.priceListeners) {
        try { listener(update); } catch { /* one consumer must not break the feed */ }
      }
    }
  }

  _heartbeat() {
    if (!this.active || !this.connectedAt) return;
    // @trade 流是事件驱动：仅在成交时推送，低成交量代币（如 ALLO/PUMP）可能
    // 长时间无成交，这是正常现象，不应因此杀掉整条连接。仅当整条连接长时间
    // 收不到任何消息（疑似真正掉线）时才重建。
    if (this.priceType === 'trade') {
      const deadMs = this.staleMs * 2;
      const since = this.lastMessageAt || this.connectedAt;
      if (Date.now() - since < deadMs) return;
      this.message = '长时间未收到任何成交行情，正在重建连接';
    } else {
      // @markPrice@1s 等定时流：每个符号都应周期性更新，任一符号超时即重建。
      const staleSymbols = this._staleSymbols();
      if (!staleSymbols.length) return;
      this.message = `${staleSymbols.join(', ')} 实时行情超时，正在重建连接`;
    }
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(4001, 'stale market stream'); } catch { /* best effort */ }
    this._scheduleReconnect(new Error(this.message));
  }

  _staleSymbols(now = Date.now()) {
    if (!this.connectedAt || now - this.connectedAt <= this.staleMs) return [];
    return this.symbols.filter((symbol) => {
      const lastAt = this.lastMessageBySymbol.get(symbol);
      return !lastAt || now - lastAt > this.staleMs;
    });
  }

  _scheduleReconnect(error) {
    if (!this.active || this._reconnectTimer) return;
    this.connectedAt = null;
    this.lastMessageAt = null;
    this.lastMessageBySymbol.clear();
    this.reconnectAttempt += 1;
    const delay = publicReconnectDelay(this.reconnectAttempt);
    this._setStatus('reconnecting', `${error?.message || '连接中断'}；${Math.ceil(delay / 1000)} 秒后重连`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
    this._reconnectTimer.unref?.();
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
  }

  _setStatus(state, message) {
    this.state = state;
    this.message = message;
    const status = this.getStatus();
    for (const listener of this.statusListeners) {
      try { listener(status); } catch { /* best effort */ }
    }
  }
}

export function subscribePublicPrices(baseSymbols, onPrice, onStatus) {
  const symbols = [...new Set(baseSymbols.map(toPublicMarketSymbol))].sort();
  const key = symbols.join(',');
  let stream = sharedPriceStreams.get(key);
  if (!stream) {
    stream = new PublicPriceStream(symbols);
    sharedPriceStreams.set(key, stream);
  }
  const unsubscribe = stream.subscribe(onPrice, onStatus);
  return {
    reconnect: () => stream.reconnect(),
    getStatus: () => stream.getStatus(),
    unsubscribe: () => {
      unsubscribe();
      if (stream.listenerCount === 0) {
        stream.close();
        sharedPriceStreams.delete(key);
      }
    },
  };
}

export function subscribeFuturesPrices(baseSymbols, onPrice, onStatus) {
  const symbols = [...new Set(baseSymbols.map(toPublicMarketSymbol))].sort();
  const key = `perp:${symbols.join(',')}`;
  let stream = sharedPriceStreams.get(key);
  if (!stream) {
    stream = new PublicPriceStream(symbols, { wsUrl:FUTURES_MARKET_DATA_WS, product:'perp' });
    sharedPriceStreams.set(key, stream);
  }
  const unsubscribe = stream.subscribe(onPrice, onStatus);
  return { reconnect:()=>stream.reconnect(), getStatus:()=>stream.getStatus(), unsubscribe:()=>{ unsubscribe(); if(stream.listenerCount===0){stream.close();sharedPriceStreams.delete(key);} } };
}

export function subscribeFuturesTradePrices(baseSymbols, onPrice, onStatus) {
  const symbols = [...new Set(baseSymbols.map(toPublicMarketSymbol))].sort();
  const key = `perp-trade:${symbols.join(',')}`;
  let stream = sharedPriceStreams.get(key);
  if (!stream) {
    stream = new PublicPriceStream(symbols, { wsUrl:FUTURES_MARKET_DATA_WS, product:'perp', priceType:'trade' });
    sharedPriceStreams.set(key, stream);
  }
  const unsubscribe = stream.subscribe(onPrice, onStatus);
  return { reconnect:()=>stream.reconnect(), getStatus:()=>stream.getStatus(), unsubscribe:()=>{ unsubscribe(); if(stream.listenerCount===0){stream.close();sharedPriceStreams.delete(key);} } };
}

export function parsePublicPriceMessage(raw) {
  return parsePublicPriceMessages(raw)[0] || null;
}

export function parsePublicPriceMessages(raw) {
  if (!raw) return [];
  let payload;
  try { payload = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return []; }
  const data = payload?.data || payload;
  if (data?.e === 'trade' && data?.s && Number(data.p) > 0) {
    return [{ symbol:toPublicMarketSymbol(data.s), price:Number(data.p), priceType:'trade', eventTime:Number(data.E) || Date.now() }];
  }
  if (data?.e === 'markPriceUpdate' && data?.s && Number(data.p) > 0) {
    return [{ symbol:toPublicMarketSymbol(data.s), price:Number(data.p), priceType:'mark', product:'perp', eventTime:Number(data.E) || Date.now() }];
  }
  return [];
}

export function publicReconnectDelay(attempt, jitter = Math.random()) {
  return Math.min(1000 * 2 ** Math.max(Number(attempt) - 1, 0), 30000) + Math.floor(jitter * 500);
}

async function decodeWebSocketData(raw) {
  if (typeof raw === 'string') return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  if (ArrayBuffer.isView(raw)) return new TextDecoder().decode(raw);
  if (raw && typeof raw.text === 'function') return raw.text();
  return String(raw || '');
}

export function toPublicMarketSymbol(baseSymbol) {
  const input = String(baseSymbol || '').trim().toUpperCase();
  if (/^@\d+$/.test(input)) return input;
  const base = input.replace(/[^A-Z0-9]/g, '');
  if (!base) throw new Error('公共行情交易对不能为空');
  if (base.endsWith('USDT')) return base;
  return `${base === 'XBT' ? 'BTC' : base}USDT`;
}

export function toHyperliquidCoin(baseSymbol) { return toPublicMarketSymbol(baseSymbol); }

export async function hydratePublicMarkets(markets, options = {}) {
  const prices = await fetchPublicPrices(markets.map((market) => market.symbol), options);
  return markets.map((market) => {
    const publicSymbol = toPublicMarketSymbol(market.symbol);
    const lastPrice = prices.get(publicSymbol);
    if (!(lastPrice > 0)) throw new Error(`公共行情缺少 ${publicSymbol} 最新价`);
    return { ...market, publicSymbol, lastPrice };
  });
}

export async function fetchPublicPrices(baseSymbols, options = {}) {
  const symbols = [...new Set(baseSymbols.map(toPublicMarketSymbol))].sort();
  if (!symbols.length) return new Map();

  const baseUrl = options.baseUrl || PUBLIC_MARKET_DATA_REST;
  const fetchImpl = options.fetchImpl || marketFetch;
  const cacheKey = `${baseUrl}:${symbols.join(',')}`;
  const cached = priceCache.get(cacheKey);
  if (!options.bypassCache && cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = (async () => {
    const query = symbols.length === 1
      ? `symbol=${encodeURIComponent(symbols[0])}`
      : `symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
    const response = await fetchImpl(`${baseUrl}/api/v3/ticker/price?${query}`, { signal:AbortSignal.timeout(options.timeoutMs || 8000) });
    if (!response.ok) throw new Error(`币安公共价格接口返回 HTTP ${response.status}`);
    const payload = await response.json();
    const prices = new Map();
    for (const row of Array.isArray(payload) ? payload : [payload]) {
      const symbol = toPublicMarketSymbol(row?.symbol);
      const price = Number(row?.price);
      if (symbols.includes(symbol) && price > 0) prices.set(symbol, price);
    }
    const missing = symbols.filter((symbol) => !prices.has(symbol));
    if (missing.length) throw new Error(`币安公共行情缺少 ${missing.join(', ')}`);
    return prices;
  })();

  priceCache.set(cacheKey, { expiresAt: Date.now() + PRICE_CACHE_TTL_MS, promise });
  try {
    return await promise;
  } catch (error) {
    priceCache.delete(cacheKey);
    throw error;
  }
}

export async function fetchFuturesPrices(baseSymbols, options = {}) {
  const symbols=[...new Set(baseSymbols.map(toPublicMarketSymbol))].sort();
  const fetchImpl=options.fetchImpl||marketFetch, baseUrl=options.baseUrl||FUTURES_MARKET_DATA_REST;
  const rows=await Promise.all(symbols.map(async symbol=>{
    const response=await fetchImpl(`${baseUrl}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`,{signal:AbortSignal.timeout(options.timeoutMs||8000)});
    if(!response.ok) throw new Error(`币安合约标记价格接口返回 HTTP ${response.status}`);
    const row=await response.json(); return [symbol,Number(row.markPrice)];
  }));
  const prices=new Map(rows.filter(([,price])=>price>0));
  if(prices.size!==symbols.length) throw new Error('币安合约标记价格数据不完整');
  return prices;
}

function normalizeTickerRows(payload, symbols) {
  const wanted = new Set(symbols);
  return (Array.isArray(payload) ? payload : [payload]).map(row => {
    const marketSymbol = toPublicMarketSymbol(row?.symbol);
    if (!wanted.has(marketSymbol)) return null;
    const price = Number(row?.lastPrice);
    if (!(price > 0)) return null;
    return {
      symbol:marketSymbol.replace(/USDT$/, ''),
      price,
      changePercent:Number(row?.priceChangePercent) || 0,
      highPrice:Number(row?.highPrice) || 0,
      lowPrice:Number(row?.lowPrice) || 0,
      volume:Number(row?.volume) || 0,
      quoteVolume:Number(row?.quoteVolume) || 0,
    };
  }).filter(Boolean);
}

export async function fetchPublicTickers(baseSymbols, options = {}) {
  const symbols = [...new Set(baseSymbols.map(toPublicMarketSymbol))].sort();
  const fetchImpl = options.fetchImpl || marketFetch;
  const baseUrl = options.baseUrl || PUBLIC_MARKET_DATA_REST;
  const query = `symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
  const response = await fetchImpl(`${baseUrl}/api/v3/ticker/24hr?${query}`, { signal:AbortSignal.timeout(options.timeoutMs || 8000) });
  if (!response.ok) throw new Error(`币安现货市场概览接口返回 HTTP ${response.status}`);
  const rows = normalizeTickerRows(await response.json(), symbols);
  if (rows.length !== symbols.length) throw new Error('币安现货市场概览数据不完整');
  return rows;
}

export async function fetchFuturesTickers(baseSymbols, options = {}) {
  const symbols = [...new Set(baseSymbols.map(toPublicMarketSymbol))].sort();
  const fetchImpl = options.fetchImpl || marketFetch;
  const baseUrl = options.baseUrl || FUTURES_MARKET_DATA_REST;
  const response = await fetchImpl(`${baseUrl}/fapi/v1/ticker/24hr`, { signal:AbortSignal.timeout(options.timeoutMs || 8000) });
  if (!response.ok) throw new Error(`币安合约市场概览接口返回 HTTP ${response.status}`);
  const rows = normalizeTickerRows(await response.json(), symbols);
  if (rows.length !== symbols.length) throw new Error('币安合约市场概览数据不完整');
  return rows;
}

export async function fetchPublicCandles(baseSymbol, intervalSec = 3600, limitInput = 200, options = {}) {
  const publicSymbol = toPublicMarketSymbol(baseSymbol);
  const normalizedIntervalSec = INTERVALS.has(Number(intervalSec)) ? Number(intervalSec) : 3600;
  const interval = INTERVALS.get(normalizedIntervalSec);
  const intervalMs = normalizedIntervalSec * 1000;
  const limit = Math.min(Math.max(Math.round(Number(limitInput) || 200), 20), 1000);
  const endTime = Date.now();
  const startTime = endTime - intervalMs * (limit + 2);
  const baseUrl = options.baseUrl || PUBLIC_MARKET_DATA_REST;
  const fetchImpl = options.fetchImpl || marketFetch;
  const cacheKey = `${baseUrl}:${publicSymbol}:${interval}:${limit}`;
  const cached = candleCache.get(cacheKey);
  if (!options.bypassCache && cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = (async () => {
    const pathPrefix = options.pathPrefix || '/api/v3';
    const url = `${baseUrl}${pathPrefix}/klines?symbol=${encodeURIComponent(publicSymbol)}&interval=${interval}&limit=${limit}`;
    const response = await fetchImpl(url, { signal:AbortSignal.timeout(options.timeoutMs || 8000) });
    if (!response.ok) throw new Error(`币安公共 K 线接口返回 HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('币安公共 K 线格式无效');

    const byTime = new Map();
    for (const row of rows) {
      const candle = {
        time: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
        low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]),
      };
      const valid = Object.values(candle).every(Number.isFinite)
        && candle.high >= Math.max(candle.open, candle.close)
        && candle.low <= Math.min(candle.open, candle.close);
      if (valid) byTime.set(candle.time, candle);
    }
    const candles = [...byTime.values()].sort((left, right) => left.time - right.time).slice(-limit);
    if (candles.length < 20) throw new Error('币安没有返回足够的 K 线');
    return candles;
  })();

  candleCache.set(cacheKey, { expiresAt: Date.now() + CANDLE_CACHE_TTL_MS, promise });
  try {
    return await promise;
  } catch (error) {
    candleCache.delete(cacheKey);
    throw error;
  }
}

export async function fetchPublicOrderBook(baseSymbol, options = {}) {
  const fetchImpl = options.fetchImpl || marketFetch;
  const baseUrl = options.baseUrl || PUBLIC_MARKET_DATA_REST;
  const coin = toPublicMarketSymbol(baseSymbol);
  const cacheKey = `${baseUrl}:${coin}`;
  const cached = orderBookCache.get(cacheKey);
  if (!options.bypassCache && cached?.expiresAt > Date.now()) return cached.promise;
  const promise = (async () => {
    const pathPrefix = options.pathPrefix || '/api/v3';
    const response = await fetchImpl(`${baseUrl}${pathPrefix}/depth?symbol=${encodeURIComponent(coin)}&limit=100`, { signal:AbortSignal.timeout(options.timeoutMs || 5000) });
    if (!response.ok) throw new Error(`币安订单簿接口返回 HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload?.bids) || !Array.isArray(payload?.asks)) throw new Error('币安订单簿格式无效');
    const normalize = rows => rows.map(row => ({ price:Number(row[0]), size:Number(row[1]), orders:0 })).filter(row => row.price > 0 && row.size >= 0);
    return { coin, time:Date.now(), bids:normalize(payload.bids), asks:normalize(payload.asks) };
  })();
  orderBookCache.set(cacheKey, { expiresAt:Date.now() + ORDER_BOOK_CACHE_TTL_MS, promise, lastValue:cached?.lastValue, lastSuccessAt:cached?.lastSuccessAt });
  try {
    const value = await promise;
    orderBookCache.set(cacheKey, { expiresAt:Date.now() + ORDER_BOOK_CACHE_TTL_MS, promise:Promise.resolve(value), lastValue:value, lastSuccessAt:Date.now() });
    return value;
  } catch (error) {
    if (cached?.lastValue && Date.now() - cached.lastSuccessAt <= ORDER_BOOK_STALE_MS) return { ...cached.lastValue, stale:true };
    orderBookCache.delete(cacheKey);
    throw error;
  }
}

export function fetchFuturesCandles(baseSymbol, intervalSec=3600, limitInput=200, options={}) {
  return fetchPublicCandles(baseSymbol,intervalSec,limitInput,{...options,baseUrl:options.baseUrl||FUTURES_MARKET_DATA_REST,pathPrefix:'/fapi/v1'});
}

export function fetchFuturesOrderBook(baseSymbol, options={}) {
  return fetchPublicOrderBook(baseSymbol,{...options,baseUrl:options.baseUrl||FUTURES_MARKET_DATA_REST,pathPrefix:'/fapi/v1'});
}

export async function fetchPublicTrades(baseSymbol, options = {}) {
  const fetchImpl = options.fetchImpl || marketFetch;
  const baseUrl = options.baseUrl || PUBLIC_MARKET_DATA_REST;
  const coin = toPublicMarketSymbol(baseSymbol);
  const cacheKey = `${baseUrl}:${coin}`;
  const cached = tradesCache.get(cacheKey);
  if (!options.bypassCache && cached?.expiresAt > Date.now()) return cached.value;
  const limit = Math.max(1, Math.min(1000, Number(options.limit) || 50));
  const pathPrefix = options.pathPrefix || '/api/v3';
  const response = await fetchImpl(`${baseUrl}${pathPrefix}/trades?symbol=${encodeURIComponent(coin)}&limit=${limit}`, { signal:AbortSignal.timeout(options.timeoutMs || 5000) });
  if (!response.ok) throw new Error(`币安成交接口返回 HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error('币安成交格式无效');
  const trades = payload.map(t => ({ id:Number(t.id), price:Number(t.price), qty:Number(t.qty), time:Number(t.time), isBuyerMaker:Boolean(t.isBuyerMaker) }));
  const value = { coin, time:Date.now(), trades };
  tradesCache.set(cacheKey, { expiresAt:Date.now() + TRADES_CACHE_TTL_MS, value });
  return value;
}

export function fetchFuturesTrades(baseSymbol, options={}) {
  return fetchPublicTrades(baseSymbol,{...options,baseUrl:options.baseUrl||FUTURES_MARKET_DATA_REST,pathPrefix:'/fapi/v1'});
}

export function resetPublicMarketDataCache() {
  priceCache.clear();
  candleCache.clear();
  orderBookCache.clear();
  tradesCache.clear();
}
