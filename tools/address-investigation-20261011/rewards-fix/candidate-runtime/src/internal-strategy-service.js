import { formatUnits, parseUnits } from 'ethers';

const STRATEGIES = ['de', 'ex', 'rs'];
const STRATEGY_MODES = new Set(['neutral', 'long', 'short']);
const NAME_BY_STRATEGY = { de:'策略 1', ex:'策略 2', rs:'策略 3' };
const BTC_DECIMALS = 8;
const USDT_DECIMALS = 6;
const PRICE_DECIMALS = 6;
const FEE_BPS = 5n;
const nowIso = () => new Date().toISOString();
const abs = value => value < 0n ? -value : value;
const ceilFee = notional => (notional * FEE_BPS + 9_999n) / 10_000n;
const notional = (size, price) => abs(size) * price / 10n ** BigInt(BTC_DECIMALS);

function units(value, decimals, label) {
  let parsed;
  try {
    const str = String(value ?? '').trim();
    if (!str || str === 'NaN' || str === 'undefined' || str === 'null') throw new Error('invalid');
    parsed = parseUnits(str, decimals);
  }
  catch { throw new Error(`${label}格式不正确`); }
  if (parsed <= 0n) throw new Error(`${label}必须大于 0`);
  return parsed;
}

function strategyKey(value) {
  const key = String(value || '').toLowerCase();
  if (!STRATEGIES.includes(key)) throw new Error('策略类型无效');
  return key;
}

function emptyStrategy(key) {
  return {
    key, name:NAME_BY_STRATEGY[key], running:false, config:null, accountingVersion:2,
    capitalUnits:'0', cashUnits:'0', inventoryUnits:'0', realizedPnlUnits:'0',
    settledEquityUnits:'0',
    entryPriceUnits:'0',
    lastPriceUnits:'0', lastGridIndex:null, badDebtUnits:'0', fills:[], alerts:[],
    startedAt:null, updatedAt:nowIso(),
  };
}

function rebuildPositionMetrics(strategy) {
  if (Number(strategy.accountingVersion) >= 2) return strategy;
  // A full reconstruction is only safe while the complete fill history is retained.
  if (!Array.isArray(strategy.fills) || strategy.fills.length >= 200) {
    strategy.accountingVersion = 2;
    return strategy;
  }
  let inventory = 0n, entry = 0n, realized = 0n;
  for (const fill of strategy.fills) {
    const size = BigInt(fill.sizeUnits || parseUnits(String(fill.size || 0), BTC_DECIMALS));
    const price = units(fill.price, PRICE_DECIMALS, '价格');
    const fee = BigInt(fill.feeUnits || parseUnits(String(fill.fee || 0), USDT_DECIMALS));
    const delta = fill.side === 'buy' ? size : -size;
    let grossPnl = 0n, closed = 0n;
    if (inventory !== 0n && (inventory > 0n) !== (delta > 0n)) {
      closed = abs(inventory) < abs(delta) ? abs(inventory) : abs(delta);
      grossPnl = inventory > 0n ? (price - entry) * closed / 10n ** BigInt(BTC_DECIMALS) : (entry - price) * closed / 10n ** BigInt(BTC_DECIMALS);
    }
    const next = inventory + delta;
    if (next === 0n) entry = 0n;
    else if (inventory === 0n || (inventory > 0n) === (delta > 0n)) {
      entry = (abs(inventory) * entry + abs(delta) * price) / abs(next);
    } else if ((next > 0n) !== (inventory > 0n)) entry = price;
    inventory = next;
    const realizedDelta = grossPnl - fee;
    realized += realizedDelta;
    fill.grossPnl = Number(formatUnits(grossPnl, USDT_DECIMALS));
    fill.realizedPnl = Number(formatUnits(realizedDelta, USDT_DECIMALS));
    fill.closing = closed > 0n;
    fill.kind = closed > 0n ? 'close' : 'open';
  }
  strategy.inventoryUnits = inventory.toString();
  strategy.entryPriceUnits = entry.toString();
  strategy.realizedPnlUnits = realized.toString();
  strategy.accountingVersion = 2;
  return strategy;
}

function entryPrice(strategy) {
  return BigInt(strategy.entryPriceUnits || '0') > 0n
    ? Number(formatUnits(BigInt(strategy.entryPriceUnits), PRICE_DECIMALS))
    : null;
}

function normalizeStored(key, value) {
  if (!value) return emptyStrategy(key);
  return rebuildPositionMetrics({ ...emptyStrategy(key), ...value, accountingVersion:Number(value.accountingVersion) || 1, key, name:NAME_BY_STRATEGY[key] });
}

export function createInternalStrategyService({ platformService, referralService = null, getMarkPrice, getMarkets = () => [] }) {
  async function price(symbol = 'BTC') {
    try {
      const raw = await getMarkPrice?.('perp', symbol);
      const value = Number(raw);
      if (!isFinite(value) || value <= 0) throw new Error('平台行情暂不可用');
      return value;
    } catch (e) {
      throw new Error('获取行情失败：' + (e?.message || String(e)));
    }
  }

  function read(address, key) {
    const normalized = strategyKey(key);
    const stored = platformService.internalStrategyState(address, normalized);
    const strategy = normalizeStored(normalized, stored);
    if (stored && !(Number(stored.accountingVersion) >= 2) && Number(strategy.accountingVersion) >= 2) {
      platformService.updateInternalStrategy(address, normalized, strategy);
    }
    return strategy;
  }

  function equity(strategy, mark) {
    return BigInt(strategy.cashUnits || '0')
      + BigInt(strategy.inventoryUnits || '0') * mark / 10n ** BigInt(BTC_DECIMALS);
  }

  function present(strategy, markNumber = 0) {
    const mark = markNumber > 0 ? units(markNumber, PRICE_DECIMALS, '价格') : BigInt(strategy.lastPriceUnits || '0');
    const capital = BigInt(strategy.capitalUnits || '0');
    const inventory = BigInt(strategy.inventoryUnits || '0');
    const settledEquity = BigInt(strategy.settledEquityUnits || '0');
    const accountEquity = !strategy.running && settledEquity > 0n
      ? settledEquity
      : mark > 0n ? equity(strategy, mark) : capital;
    const pnl = accountEquity - capital;
    const safeEquity = accountEquity > 0n ? accountEquity : 0n;
    return {
      exchange:strategy.key, strategyName:strategy.name, mode:'internal', dataSource:'platform', network:'internal',
      running:Boolean(strategy.running), recovery:false, config:strategy.config,
      capital:formatUnits(capital, USDT_DECIMALS), balance:formatUnits(safeEquity, USDT_DECIMALS), equity:formatUnits(safeEquity, USDT_DECIMALS),
      totalPnl:Number(formatUnits(pnl, USDT_DECIMALS)), returnPct:capital > 0n ? Number(pnl * 1_000_000n / capital) / 10_000 : 0,
      realizedPnl:Number(formatUnits(BigInt(strategy.realizedPnlUnits || '0'), USDT_DECIMALS)),
      unrealizedPnl:Number(formatUnits(pnl - BigInt(strategy.realizedPnlUnits || '0'), USDT_DECIMALS)),
      lastPrice:mark > 0n ? Number(formatUnits(mark, PRICE_DECIMALS)) : null,
      marketPrices:mark > 0n ? { [strategy.config?.marketId || 'BTC']:Number(formatUnits(mark, PRICE_DECIMALS)) } : {},
      position:inventory === 0n ? null : { symbol:strategy.config?.symbol || 'BTC', sizeBase:Number(formatUnits(inventory, BTC_DECIMALS)), entryPrice:entryPrice(strategy), unrealizedPnl:Number(formatUnits(pnl - BigInt(strategy.realizedPnlUnits || '0'), USDT_DECIMALS)) },
      stats:{
        buys:strategy.fills.filter(fill => fill.side === 'buy').length,
        sells:strategy.fills.filter(fill => fill.side === 'sell').length,
        completedRungs:strategy.fills.length,
        gridProfit:Number(formatUnits(pnl, USDT_DECIMALS)),
        volume:Number(formatUnits(strategy.fills.reduce((sum, fill) => sum + BigInt(fill.notionalUnits || '0'), 0n), USDT_DECIMALS)),
      },
      openOrders:strategy.running && strategy.config ? Math.max(0, Number(strategy.config.gridCount || 0) - 1) : 0,
      fills:strategy.fills.slice(-100).reverse(), alerts:strategy.alerts.slice(-100).reverse(), outOfRange:false,
      health:{ status:strategy.running ? 'running' : 'idle', reason:strategy.running ? '平台内部策略运行中' : '未运行', dataSource:'platform', dataProvider:'internal-ledger', priceTransport:'platform-feed', priceStreamState:'live', priceStale:false },
      cash:formatUnits(BigInt(strategy.cashUnits || '0'), USDT_DECIMALS), inventory:formatUnits(inventory, BTC_DECIMALS), badDebt:formatUnits(BigInt(strategy.badDebtUnits || '0'), USDT_DECIMALS),
    };
  }

  function markets(key) {
    const strategyName = NAME_BY_STRATEGY[strategyKey(key)];
    const configured = getMarkets().filter(item => item?.enabled !== false && item?.perp !== false);
    const source = configured.length ? configured : [{ symbol:'BTC', priceDecimals:2 }];
    const minimums = { BTC:0.0001, ETH:0.001, BNB:0.01, SOL:0.01, XRP:1, DOGE:1 };
    return source.map((item) => {
      const symbol = String(item.symbol || '').toUpperCase();
      const priceDecimals = Math.max(0, Math.min(6, Number(item.priceDecimals) || 2));
      return { marketId:symbol, name:`${symbol}-USDT`, displayName:`${symbol} / USDT · ${strategyName}`, symbol, publicSymbol:`${symbol}USDT`, lastPrice:0, stepSize:0.00000001, stepPrice:10 ** -priceDecimals, minOrderSize:minimums[symbol] || 0.0001 };
    });
  }

  function configFor(key, body) {
    const lower = Number(body.lower), upper = Number(body.upper), gridCount = Math.trunc(Number(body.gridCount));
    const sizeBase = Number(body.sizeBase), leverage = Number(body.leverage) || 1;
    const mode = String(body.mode || 'neutral').toLowerCase();
    const marketList = markets(key);
    const requestedMarket = String(body.marketId || body.symbol || 'BTC').toUpperCase();
    const market = marketList.find(item => item.marketId === requestedMarket || item.symbol === requestedMarket)
      || (requestedMarket === '1' ? marketList.find(item => item.symbol === 'BTC') : null);
    if (!(lower > 0 && upper > lower)) throw new Error('网格区间无效');
    if (!Number.isInteger(gridCount) || gridCount < 2 || gridCount > 500) throw new Error('网格数量必须为 2 到 500');
    if (!(sizeBase > 0 && Number.isFinite(sizeBase))) throw new Error('每格数量无效');
    if (!Number.isSafeInteger(leverage) || leverage < 1) throw new Error('杠杆必须为大于等于 1 的整数');
    if (!STRATEGY_MODES.has(mode)) throw new Error('策略方向必须为中性、做多或做空');
    if (!market) throw new Error('所选交易对未启用或不存在');
    return { marketId:market.marketId, symbol:market.symbol, displayName:`${market.symbol} / USDT`, mode, lower, upper, gridCount, sizeBase, leverage, outOfRangeAction:body.outOfRangeAction === 'recover' ? 'recover' : 'close' };
  }

  async function start(address, keyValue, body = {}) {
    const key = strategyKey(keyValue), existing = read(address, key);
    if (existing.running) throw new Error('策略已经在运行');
    const runningCount = STRATEGIES.filter(strategy => read(address, strategy).running).length;
    if (runningCount >= STRATEGIES.length) throw new Error('最多同时运行 3 个策略');
    const config = configFor(key, body), capital = units(body.capital, USDT_DECIMALS, '投入金额');
    const markNumber = await price(config.symbol), mark = units(markNumber, PRICE_DECIMALS, '价格');
    const step = (config.upper - config.lower) / config.gridCount;
    const next = {
      ...emptyStrategy(key), running:true, config, capitalUnits:capital.toString(), cashUnits:capital.toString(),
      lastPriceUnits:mark.toString(), lastGridIndex:Math.max(0, Math.min(config.gridCount, Math.floor((markNumber - config.lower) / step))),
      startedAt:nowIso(), updatedAt:nowIso(),
    };
    platformService.startInternalStrategy(address, key, next, capital);
    return present(next, markNumber);
  }

  async function stop(address, keyValue) {
    const key = strategyKey(keyValue), item = read(address, key);
    if (!item.running) return present(item);
    const markNumber = await price(item.config?.symbol || 'BTC'), mark = units(markNumber, PRICE_DECIMALS, '价格');
    const accountEquity = equity(item, mark), settlement = accountEquity > 0n ? accountEquity : 0n;
    const stopped = { ...item, running:false, cashUnits:'0', inventoryUnits:'0', settledEquityUnits:settlement.toString(), lastPriceUnits:mark.toString(), badDebtUnits:accountEquity < 0n ? (-accountEquity).toString() : item.badDebtUnits, updatedAt:nowIso() };
    platformService.settleInternalStrategy(address, key, stopped, settlement);
    return present(stopped, markNumber);
  }

  function applyFill(address, key, item, side, pxNumber) {
    const px = units(pxNumber.toFixed(PRICE_DECIMALS), PRICE_DECIMALS, '价格'), configuredSize = units(item.config.sizeBase, BTC_DECIMALS, '每格数量');
    const cash = BigInt(item.cashUnits), inventory = BigInt(item.inventoryUnits), capital = BigInt(item.capitalUnits), oldEntry = BigInt(item.entryPriceUnits || '0');
    let size = configuredSize, tradeNotional = notional(size, px), fee = ceilFee(tradeNotional);
    if (side === 'buy') {
      const maxSize = cash > fee ? (cash - fee) * 10n ** BigInt(BTC_DECIMALS) / px : 0n;
      if (maxSize <= 0n) return false;
      if (size > maxSize) size = maxSize;
      tradeNotional = notional(size, px); fee = ceilFee(tradeNotional);
      item.cashUnits = (cash - tradeNotional - fee).toString(); item.inventoryUnits = (inventory + size).toString();
    } else {
      const nextInventory = inventory - size;
      if (notional(nextInventory, px) > capital * BigInt(item.config.leverage)) return false;
      item.cashUnits = (cash + tradeNotional - fee).toString(); item.inventoryUnits = nextInventory.toString();
    }
    const nextInventory = BigInt(item.inventoryUnits);
    const delta = nextInventory - inventory;
    const opposing = inventory !== 0n && (inventory > 0n) !== (delta > 0n);
    const closed = opposing ? (abs(inventory) < abs(delta) ? abs(inventory) : abs(delta)) : 0n;
    const grossPnl = closed > 0n
      ? (inventory > 0n ? (px - oldEntry) * closed : (oldEntry - px) * closed) / 10n ** BigInt(BTC_DECIMALS)
      : 0n;
    const realizedDelta = grossPnl - fee;
    let nextEntry = oldEntry;
    if (nextInventory === 0n) nextEntry = 0n;
    else if (inventory === 0n || !opposing) nextEntry = (abs(inventory) * oldEntry + abs(delta) * px) / abs(nextInventory);
    else if ((nextInventory > 0n) !== (inventory > 0n)) nextEntry = px;
    item.entryPriceUnits = nextEntry.toString();
    item.realizedPnlUnits = (BigInt(item.realizedPnlUnits || '0') + realizedDelta).toString();
    const filledAt = Date.now();
    const fill = { id:`isf_${key}_${filledAt}_${item.fills.length}`, t:filledAt, side, price:pxNumber, size:Number(formatUnits(size, BTC_DECIMALS)), sizeUnits:size.toString(), fee:Number(formatUnits(fee, USDT_DECIMALS)), feeUnits:fee.toString(), notionalUnits:tradeNotional.toString(), grossPnl:Number(formatUnits(grossPnl, USDT_DECIMALS)), realizedPnl:Number(formatUnits(realizedDelta, USDT_DECIMALS)), closing:closed > 0n, kind:closed > 0n ? 'close' : 'open' };
    item.fills.push(fill);
    referralService?.distributeTradingFee(address, fee, fill.id, filledAt);
    if (item.fills.length > 200) item.fills.splice(0, item.fills.length - 200);
    return true;
  }

  async function processPrice(symbolInput, value) {
    const symbol = String(symbolInput || 'BTC').toUpperCase().replace(/USDT$/, '');
    const pxNumber = Number(value);
    if (!(pxNumber > 0)) return;
    const mark = units(pxNumber.toFixed(PRICE_DECIMALS), PRICE_DECIMALS, '价格');
    for (const address of platformService.internalStrategyAccounts()) for (const key of STRATEGIES) {
      const item = read(address, key);
      if (!item.running || !item.config) continue;
      if (String(item.config.symbol || 'BTC').toUpperCase() !== symbol) continue;
      const cfg = item.config, step = (cfg.upper - cfg.lower) / cfg.gridCount;
      const oldIndex = item.lastGridIndex == null ? Math.floor((Number(formatUnits(item.lastPriceUnits, PRICE_DECIMALS)) - cfg.lower) / step) : Number(item.lastGridIndex);
      const nextIndex = Math.floor((pxNumber - cfg.lower) / step);
      if (pxNumber < cfg.lower || pxNumber > cfg.upper) {
        if (!item.alerts.at(-1) || Date.now() - Number(item.alerts.at(-1).t) > 60_000) item.alerts.push({ t:Date.now(), message:'价格已超出策略区间' });
        if (cfg.outOfRangeAction === 'close') {
          const accountEquity = equity(item, mark), settlement = accountEquity > 0n ? accountEquity : 0n;
          const stopped = { ...item, running:false, cashUnits:'0', inventoryUnits:'0', settledEquityUnits:settlement.toString(), lastPriceUnits:mark.toString(), badDebtUnits:accountEquity < 0n ? (-accountEquity).toString() : item.badDebtUnits, updatedAt:nowIso() };
          platformService.settleInternalStrategy(address, key, stopped, settlement);
          continue;
        }
      } else if (nextIndex !== oldIndex) {
        const side = nextIndex > oldIndex ? 'sell' : 'buy';
        const allowed = cfg.mode === 'neutral' || (cfg.mode === 'long' ? side === 'buy' || BigInt(item.inventoryUnits) > 0n : side === 'sell' || BigInt(item.inventoryUnits) < 0n);
        if (allowed) applyFill(address, key, item, side, pxNumber);
        item.lastGridIndex = nextIndex;
        item.lastPriceUnits = mark.toString(); item.updatedAt = nowIso();
        platformService.updateInternalStrategy(address, key, item);
      }
    }
  }

  async function adjust(address, keyValue, body = {}) {
    const key = strategyKey(keyValue), item = read(address, key);
    if (!item.running || !item.config) throw new Error('策略未运行');
    item.config = configFor(key, { ...item.config, ...body }); item.updatedAt = nowIso();
    platformService.updateInternalStrategy(address, key, item); return present(item, Number(formatUnits(item.lastPriceUnits, PRICE_DECIMALS)));
  }

  function stateFor(address, keyValue, mark = 0) { return present(read(address, keyValue), Number(mark)); }
  function allFor(address, mark = 0) { return Object.fromEntries(STRATEGIES.map(key => [key, stateFor(address, key, mark)])); }
  for (const address of platformService.internalStrategyAccounts()) {
    for (const key of STRATEGIES) read(address, key);
  }
  return { allFor, adjust, markets, processPrice, start, stateFor, stop };
}
