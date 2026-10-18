// PaperExchange: simulated RISEx trading driven by free public market data.
// Hyperliquid public prices and candles are used as a BTC/ETH market proxy;
// only order fills, positions, balances, and PnL are simulated locally.
import { EventEmitter } from 'node:events';
import {
  PUBLIC_MARKET_DATA_LABEL,
  PUBLIC_MARKET_DATA_PROVIDER,
  PUBLIC_MARKET_DATA_REST,
  fetchPublicCandles,
  fetchPublicPrices,
  hydratePublicMarkets,
  subscribePublicPrices,
} from '../../market-data/public.js';

const FALLBACK_MARKETS = [
  { marketId: 1, displayName: 'BTC-PERP', symbol: 'BTC', lastPrice: 61000, stepSize: 0.001, stepPrice: 0.1, maxLeverage: 50, minOrderSize: 0.001 },
  { marketId: 2, displayName: 'ETH-PERP', symbol: 'ETH', lastPrice: 3000, stepSize: 0.001, stepPrice: 0.01, maxLeverage: 50, minOrderSize: 0.001 },
];

export class PaperExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'paper';
    const configuredBalance = Number(opts.startBalance ?? 10000);
    this.initialBalance = Number.isFinite(configuredBalance) && configuredBalance >= 0
      ? configuredBalance
      : 10000;
    this.balance = this.initialBalance;
    this.apiUrl = PUBLIC_MARKET_DATA_REST;
    this.dataProvider = PUBLIC_MARKET_DATA_PROVIDER;
    this.dataProviderLabel = PUBLIC_MARKET_DATA_LABEL;
    this.dataSource = 'connecting';   // 'real' | 'synthetic'
    this.network = 'public';
    this.tickMs = opts.tickMs ?? 1000;
    this.pollMs = opts.pollMs ?? 5000;
    this.volPerTick = opts.volPerTick ?? 0.0015; // only for synthetic fallback
    this.feeRate = Number(opts.feeRate) || 0.0005; // simulated fee rate per fill
    this.markets = new Map();
    this.orders = new Map();
    this.positions = new Map();
    this.realizedPnl = 0;
    this.lastOkAt = Date.now();
    this.lastError = null;
    this.prices = new Map();      // displayed/simulated price
    this.realTarget = new Map();  // latest real price target
    this.priceTransport = 'connecting';
    this.priceStreamState = 'stopped';
    this.priceStreamMessage = '';
    this.lastWsAt = 0;
    this.lastWsAtBySymbol = new Map();
    this._seq = 1;
    this._tickTimer = null;
    this._pollTimer = null;
    this._priceSubscription = null;
  }

  async init() {
    try {
      const list = await hydratePublicMarkets(FALLBACK_MARKETS);
      this._setMarkets(list);
      this.dataSource = 'real';
      this.priceTransport = 'rest';
      this.lastOkAt = Date.now();
      this.lastError = null;
    } catch (error) {
      this.dataSource = 'synthetic';
      this.priceTransport = 'synthetic';
      this.lastError = error;
      this._setMarkets(FALLBACK_MARKETS.map((m) => ({ ...m })));
      console.error(`[RISEx 模拟盘] ${PUBLIC_MARKET_DATA_LABEL}连接失败，暂用合成行情：${error?.message || error}`);
    }
    for (const [id, m] of this.markets) {
      this.prices.set(id, m.lastPrice || 100);
      this.realTarget.set(id, m.lastPrice || 100);
    }
    this._startLoops();           // keep price live even before bot starts
    return true;
  }

  /** Reconnect the free public feed and upgrade synthetic data when reachable. */
  async reconnect() {
    const hadSubscription = !!this._priceSubscription;
    try {
      const list = await hydratePublicMarkets(FALLBACK_MARKETS, { bypassCache: true });
      this.dataSource = 'real';
      this.priceTransport = 'rest';
      this._setMarkets(list);
      for (const [id, m] of this.markets) {
        this._applyRealPrice(id, m.lastPrice || 100, 'rest');
      }
      this.lastOkAt = Date.now();
      this.lastError = null;
    } catch (error) {
      this.lastError = error;
      if (this.dataSource === 'synthetic') this.priceTransport = 'synthetic';
      throw error;
    }
    this._startLoops();
    if (hadSubscription) this._priceSubscription?.reconnect();
    return true;
  }

  _setMarkets(list) { this.markets.clear(); for (const m of list) this.markets.set(m.marketId, m); }

  async getMarkets() { return [...this.markets.values()]; }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const m = this.markets.get(Number(marketId));
    if (this.dataSource === 'real' && m?.symbol) {
      try {
        const candles = await fetchPublicCandles(m.symbol, intervalSec, n);
        this.lastOkAt = Date.now();
        this.lastError = null;
        return candles;
      } catch (error) {
        this.lastError = error;
        return [];
      }
    }
    return synthCandles(this.prices.get(marketId) || 100, n);
  }

  async getPrice(marketId) { return this.prices.get(marketId); }
  async setLeverage() { return true; }

  async placeLimitOrder(o) {
    const id = `paper-${this._seq++}`;
    this.orders.set(id, { orderId: id, ...o });
    return { orderId: id };
  }
  async cancelOrder(_m, orderId) { this.orders.delete(orderId); return true; }
  async cancelAll(marketId) { for (const [id, o] of this.orders) if (o.marketId === marketId) this.orders.delete(id); return true; }
  getOpenOrders(marketId) { return [...this.orders.values()].filter((o) => o.marketId === marketId); }
  async fetchOpenOrders(marketId) {
    return [...this.orders.values()]
      .filter((o) => Number(o.marketId) === Number(marketId))
      .map((o) => ({ orderId: String(o.orderId), price: Number(o.price), side: o.side }));
  }

  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase }) {
    this.orders.set(String(orderId), { orderId: String(orderId), marketId: Number(marketId), levelIndex, side, price: Number(price), sizeBase: Number(sizeBase), reduceOnly: false });
  }

  snapshotAccount() {
    return { version: 1, balance: this.balance, realizedPnl: this.realizedPnl, positions: [...this.positions.entries()], seq: this._seq };
  }

  restoreAccount(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    if (Number.isFinite(Number(snapshot.balance))) this.balance = Number(snapshot.balance);
    if (Number.isFinite(Number(snapshot.realizedPnl))) this.realizedPnl = Number(snapshot.realizedPnl);
    this.positions.clear();
    for (const [marketId, position] of (Array.isArray(snapshot.positions) ? snapshot.positions : [])) {
      const sizeBase = Number(position?.sizeBase), entryPrice = Number(position?.entryPrice);
      if (Number.isFinite(sizeBase) && sizeBase !== 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
        this.positions.set(Number(marketId), { sizeBase, entryPrice });
      }
    }
    if (Number.isFinite(Number(snapshot.seq)) && Number(snapshot.seq) > 0) this._seq = Number(snapshot.seq);
    return true;
  }

  getPosition(marketId) {
    const p = this.positions.get(marketId);
    if (!p || p.sizeBase === 0) return null;
    const last = this.prices.get(marketId);
    return { sizeBase: p.sizeBase, entryPrice: p.entryPrice, unrealizedPnl: p.sizeBase * (last - p.entryPrice) };
  }

  async closePosition(marketId) {
    const id = Number(marketId);
    const p = this.positions.get(id);
    if (!p || !p.sizeBase) return null;
    const price = this.prices.get(id);
    this._applyFill(id, p.sizeBase > 0 ? 'sell' : 'buy', price, Math.abs(p.sizeBase));
    return true;
  }

  /** Restore a clean paper account without touching the live market feed. */
  async resetAccount() {
    this.orders.clear();
    this.positions.clear();
    this.balance = this.initialBalance;
    this.realizedPnl = 0;
    this._seq = 1;
    return { balance: this.balance, realizedPnl: 0 };
  }

  start() { this._startLoops(); }   // no-op if already running
  stop() { /* keep price feed alive across bot stop/start */ }

  _startLoops() {
    if (!this._tickTimer) { this._tickTimer = setInterval(() => this._tick(), this.tickMs); this._tickTimer.unref?.(); }
    if (this.dataSource === 'real' && !this._pollTimer) {
      this._pollTimer = setInterval(() => this._pollReal(), this.pollMs); this._pollTimer.unref?.();
    }
    if (this.dataSource === 'real' && !this._priceSubscription) {
      this._priceSubscription = subscribePublicPrices(
        [...this.markets.values()].map((market) => market.symbol),
        (update) => this._handlePublicPrice(update),
        (status) => {
          this.priceStreamState = status.state;
          this.priceStreamMessage = status.message;
          if (status.state === 'live') this.priceTransport = 'websocket';
        },
      );
    }
  }

  async _pollReal() {
    const now = Date.now();
    const markets = [...this.markets.values()];
    const staleSymbols = markets
      .filter((market) => now - (this.lastWsAtBySymbol.get(market.publicSymbol) || 0) >= 3000)
      .map((market) => market.symbol);
    if (!staleSymbols.length) return;
    try {
      const prices = await fetchPublicPrices(staleSymbols);
      const transport = staleSymbols.length < markets.length ? 'hybrid' : 'rest';
      for (const [id, m] of this.markets) {
        const price = prices.get(m.publicSymbol);
        if (price) this._applyRealPrice(id, price, transport);
      }
    } catch (error) { this.lastError = error; }
  }

  _handlePublicPrice(update) {
    for (const [id, market] of this.markets) {
      if (market.publicSymbol !== update.symbol) continue;
      this.lastWsAt = update.receivedAt || Date.now();
      this.lastWsAtBySymbol.set(update.symbol, this.lastWsAt);
      this._applyRealPrice(id, update.price, 'websocket');
    }
  }

  _applyRealPrice(marketId, price, transport) {
    const next = Number(price);
    if (!(next > 0)) return;
    const previous = this.prices.get(marketId);
    this.prices.set(marketId, next);
    this.realTarget.set(marketId, next);
    this.priceTransport = transport;
    this.lastOkAt = Date.now();
    this.lastError = null;
    this.emit('price', { marketId, price: next, transport, receivedAt: this.lastOkAt });
    if (Number.isFinite(previous) && previous > 0 && previous !== next) this._matchFills(marketId, previous, next);
  }

  _tick() {
    if (this.dataSource === 'real') return;
    if (this.dataSource === 'synthetic') this.lastOkAt = Date.now();
    for (const [id, price] of this.prices) {
      const seed = this.markets.get(id)?.lastPrice || price;
      const drift = (seed - price) / seed * 0.02;
      const shock = (Math.random() * 2 - 1) * this.volPerTick;
      const next = Math.max(0.0001, price * (1 + drift + shock));
      this.prices.set(id, next);
      this.emit('price', { marketId: id, price: next, transport: 'synthetic', receivedAt: Date.now() });
      this._matchFills(id, price, next);
    }
  }

  _matchFills(marketId, prev, cur) {
    for (const o of [...this.orders.values()]) {
      if (o.marketId !== marketId) continue;
      const crossedBuy = o.side === 'buy' && cur <= o.price;
      const crossedSell = o.side === 'sell' && cur >= o.price;
      if (!crossedBuy && !crossedSell) continue;
      if (o.reduceOnly && !this._reduces(marketId, o.side)) { this.orders.delete(o.orderId); continue; }
      this.orders.delete(o.orderId);
      const result = this._applyFill(marketId, o.side, o.price, o.sizeBase);
      this.emit('fill', { orderId: o.orderId, marketId, side: o.side, price: o.price, sizeBase: o.sizeBase, levelIndex: o.levelIndex, clientOrderId: o.clientOrderId, ...result });
    }
  }

  _reduces(marketId, side) {
    const p = this.positions.get(marketId);
    if (!p || p.sizeBase === 0) return false;
    return side === 'sell' ? p.sizeBase > 0 : p.sizeBase < 0;
  }

  _applyFill(marketId, side, price, qty) {
    // Simulate trading fees so paper results don't overstate real performance
    // (the live fee-vs-spacing check reads this.feeRate too, keeping them consistent).
    const fee = price * qty * this.feeRate;
    this.balance -= fee;
    this.realizedPnl -= fee;
    const p = this.positions.get(marketId) || { sizeBase: 0, entryPrice: 0 };
    const signed = side === 'buy' ? qty : -qty;
    let grossPnl = 0;
    let closingSize = 0;
    if (p.sizeBase === 0 || Math.sign(p.sizeBase) === Math.sign(signed)) {
      const newSize = p.sizeBase + signed;
      p.entryPrice = (Math.abs(p.sizeBase) * p.entryPrice + Math.abs(signed) * price) / Math.abs(newSize);
      p.sizeBase = newSize;
    } else {
      const closeQty = Math.min(Math.abs(p.sizeBase), Math.abs(signed));
      const pnl = p.sizeBase > 0 ? closeQty * (price - p.entryPrice) : closeQty * (p.entryPrice - price);
      grossPnl = pnl;
      closingSize = closeQty;
      this.realizedPnl += pnl; this.balance += pnl;
      const remaining = p.sizeBase + signed;
      if (Math.sign(remaining) === Math.sign(p.sizeBase) || remaining === 0) { p.sizeBase = remaining; if (remaining === 0) p.entryPrice = 0; }
      else { p.sizeBase = remaining; p.entryPrice = price; }
    }
    this.positions.set(marketId, p);
    return { fee, grossPnl, realizedPnl: grossPnl - fee, closing: closingSize > 0, closingSize };
  }
}

function synthCandles(start, n) {
  const out = []; let price = start; let t = Date.now() - n * 3600_000;
  const regime = Math.random() < 0.34 ? 0.0012 : Math.random() < 0.5 ? -0.0012 : 0;
  for (let i = 0; i < n; i++) {
    const open = price, close = price * (1 + regime + (Math.random() * 2 - 1) * 0.006);
    out.push({ time: t, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 100 });
    price = close; t += 3600_000;
  }
  return out;
}
