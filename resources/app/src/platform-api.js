import crypto from 'node:crypto';
import { MAX_PERP_LEVERAGE, PLATFORM_SYMBOLS } from './platform-service.js';

const MARKET_MAX_AGE_MS = 5_000;
const MARKET_PRICE_DECIMALS = 2;
const CLIENT_ORDER_ID = /^[A-Za-z0-9._:-]{8,80}$/;
const normalizeMarketPrice = value => {
  const price = Number(value);
  return price > 0 && Number.isFinite(price) ? Number(price.toFixed(MARKET_PRICE_DECIMALS)) : 0;
};

function apiError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function errorCode(error) {
  if (error?.code) return error.code;
  const message = String(error?.message || '平台请求失败');
  if (message.includes('余额不足')) return 'INSUFFICIENT_BALANCE';
  if (message.includes('不存在')) return 'NOT_FOUND';
  if (message.includes('格式') || message.includes('必须') || message.includes('无效')) return 'VALIDATION_ERROR';
  return 'PLATFORM_ERROR';
}

function requestHash(body) {
  const normalized = {
    product:body.product === 'spot' ? 'spot' : 'perp',
    symbol:String(body.symbol || 'BTC').toUpperCase(),
    type:['limit', 'trigger'].includes(body.type) ? body.type : 'market',
    side:body.side === 'sell' ? 'sell' : 'buy',
    size:String(body.size ?? '').trim(),
    leverage:Math.trunc(Number(body.leverage) || 1),
    marginMode:body.marginMode === 'cross' ? 'cross' : 'isolated',
    limitPrice:String(body.limitPrice ?? '').trim(),
    triggerPrice:String(body.triggerPrice ?? '').trim(),
    triggerDirection:body.triggerDirection === 'below' ? 'below' : 'above',
    reduceOnly:Boolean(body.reduceOnly),
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function validateOrder(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw apiError('VALIDATION_ERROR', '订单参数格式不正确');
  if (!['spot', 'perp'].includes(body.product)) throw apiError('VALIDATION_ERROR', '交易产品无效');
  if (!PLATFORM_SYMBOLS.includes(String(body.symbol || 'BTC').toUpperCase())) throw apiError('VALIDATION_ERROR', '暂不支持该交易币种');
  if (!['market', 'limit', 'trigger'].includes(body.type)) throw apiError('VALIDATION_ERROR', '订单类型无效');
  if (!['buy', 'sell'].includes(body.side)) throw apiError('VALIDATION_ERROR', '交易方向无效');
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) throw apiError('VALIDATION_ERROR', '代币数量必须大于 0');
  if (body.product === 'perp') {
    const leverage = Number(body.leverage);
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > MAX_PERP_LEVERAGE) throw apiError('VALIDATION_ERROR', `杠杆必须是 1 到 ${MAX_PERP_LEVERAGE} 的整数`);
    if (!['isolated', 'cross'].includes(body.marginMode || 'isolated')) throw apiError('VALIDATION_ERROR', '保证金模式无效');
  }
  if (body.reduceOnly && body.product !== 'perp') throw apiError('VALIDATION_ERROR', '只有永续合约支持只减仓');
  if (body.type === 'limit') {
    const limitPrice = Number(body.limitPrice);
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) throw apiError('VALIDATION_ERROR', '限价必须大于 0');
  }
  if (body.type === 'trigger') {
    const triggerPrice = Number(body.triggerPrice);
    if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) throw apiError('VALIDATION_ERROR', '触发价必须大于 0');
    if (!['above', 'below'].includes(body.triggerDirection)) throw apiError('VALIDATION_ERROR', '触发方向无效');
  }
}

export function createPlatformApi({ platformService, fetchPrices, fetchFuturesPrices = fetchPrices, send, readBody, getSession }) {
  const accountQueues = new Map();
  const markets = new Map();

  function withAccountLock(address, operation) {
    const key = String(address || '').toLowerCase();
    const previous = accountQueues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    accountQueues.set(key, current);
    return current.finally(() => { if (accountQueues.get(key) === current) accountQueues.delete(key); });
  }

  function updateMarket(update) {
    const price = normalizeMarketPrice(update?.price);
    if (!(price > 0)) return;
    const receivedAt = Number(update.receivedAt) || Date.now();
    const products = update?.product ? [update.product === 'spot' ? 'spot' : 'perp'] : ['spot', 'perp'];
    for (const product of products) {
      const symbol = String(update.symbol || 'BTC').toUpperCase().replace(/USDT$/, '');
      if (!PLATFORM_SYMBOLS.includes(symbol)) continue;
      const key = `${product}:${symbol}`;
      const previous = markets.get(key);
      if (previous && receivedAt < previous.receivedAt) continue;
      markets.set(key, { price, receivedAt, source:'binance-websocket' });
      platformService.processMarkPrice(product, symbol, price);
    }
  }

  async function marketPrice(product = 'perp', symbolInput = 'BTC', { allowStale = false } = {}) {
    const normalized = product === 'spot' ? 'spot' : 'perp';
    const symbol = String(symbolInput || 'BTC').toUpperCase();
    if (!PLATFORM_SYMBOLS.includes(symbol)) throw apiError('VALIDATION_ERROR', '暂不支持该交易币种');
    const key = `${normalized}:${symbol}`, cached = markets.get(key);
    if (cached && Date.now() - cached.receivedAt <= MARKET_MAX_AGE_MS) return cached.price;
    try {
      const prices = await (normalized === 'perp' ? fetchFuturesPrices : fetchPrices)([symbol]);
      const price = normalizeMarketPrice(prices?.get?.(`${symbol}USDT`) ?? prices?.get?.(symbol) ?? prices?.values?.().next().value);
      if (!(price > 0)) throw new Error('价格为空');
      markets.set(key, { price, receivedAt:Date.now(), source:'rest' });
      if (normalized === 'perp') platformService.processMarkPrice('perp', symbol, price);
      return price;
    } catch (error) {
      if (allowStale && cached?.price > 0) return cached.price;
      throw apiError('MARKET_UNAVAILABLE', `币安行情暂不可用：${error?.message || error}`, 503);
    }
  }

  async function executeOrder(address, body, suppliedClientOrderId = '') {
    validateOrder(body);
    const clientOrderId = String(suppliedClientOrderId || body.clientOrderId || `srv_${crypto.randomBytes(12).toString('hex')}`).trim();
    if (!CLIENT_ORDER_ID.test(clientOrderId)) throw apiError('INVALID_CLIENT_ORDER_ID', '请求编号格式不正确');
    const hash = requestHash(body);
    return withAccountLock(address, async () => {
      const existing = platformService.findExecution(address, clientOrderId, hash);
      if (existing) return { ok:true, replayed:true, clientOrderId, ...existing };
      const product = body.product === 'spot' ? 'spot' : 'perp';
      const symbol = String(body.symbol || 'BTC').toUpperCase();
      const price = await marketPrice(product, symbol);
      if (body.type === 'limit' || body.type === 'trigger') {
        const order = platformService.placeOrder(address, { ...body, symbol, clientOrderId, requestHash:hash }, price);
        return { ok:true, replayed:false, clientOrderId, price, order };
      }
      const args = { ...body, symbol, price, clientOrderId, requestHash:hash };
      const fill = product === 'spot' ? platformService.spotTrade(address, args) : platformService.perpTrade(address, args);
      return { ok:true, replayed:false, clientOrderId, price, fill };
    });
  }

  function sendError(res, error) {
    const message = error?.message || String(error);
    send(res, Number(error?.statusCode) || 400, { error:message, code:errorCode(error) });
  }

  async function handle(request, res, pathname) {
    if (!pathname.startsWith('/api/platform/')) return false;
    if (pathname === '/api/platform/status' && request.method === 'GET') {
      const marketStatus = Object.fromEntries([...markets.entries()].map(([key,snapshot])=>[key,{price:snapshot.price,source:snapshot.source,ageMs:Math.max(0,Date.now()-snapshot.receivedAt)}]));
      send(res, 200, { ok:true, ...platformService.systemStatus(), markets:marketStatus });
      return true;
    }
    const session = getSession(request);
    if (!session) {
      send(res, 401, { error:'请连接钱包', code:'SESSION_REQUIRED' });
      return true;
    }
    try {
      if (pathname === '/api/platform/profile' && request.method === 'GET') {
        const selectedSymbol = String(new URL(request.url,'http://localhost').searchParams.get('symbol') || 'BTC').toUpperCase();
        const priceEntries = await Promise.all(PLATFORM_SYMBOLS.map(async symbol=>[symbol,await marketPrice('perp',symbol,{allowStale:true}).catch(()=>0)]));
        const spotPriceEntries = await Promise.all(PLATFORM_SYMBOLS.map(async symbol=>[symbol,await marketPrice('spot',symbol,{allowStale:true}).catch(()=>0)]));
        const markPrices = Object.fromEntries(priceEntries);
        // 资产页 marketPrices 注入 AIX 现价（来自 AIX 交易页 priceProvider），让 AIX 行的市值列按现价折算 USDT
        const aixPrice = platformService.aTokenSpotPrice?.() || 0;
        send(res, 200, { connected:true, symbols:PLATFORM_SYMBOLS, marketPrices:{ ...Object.fromEntries(spotPriceEntries), A:aixPrice }, ...platformService.profile(session.address, markPrices, selectedSymbol) });
        return true;
      }
      if (pathname === '/api/platform/order' && request.method === 'POST') {
        const body = await readBody(request);
        send(res, 200, await executeOrder(session.address, body, request.headers['idempotency-key']));
        return true;
      }
      if (pathname.startsWith('/api/platform/orders/') && request.method === 'DELETE') {
        const orderId = decodeURIComponent(pathname.slice('/api/platform/orders/'.length));
        const order = await withAccountLock(session.address, () => platformService.cancelOrder(session.address, orderId));
        send(res, 200, { ok:true, order });
        return true;
      }
      if ((pathname === '/api/platform/stake' || pathname === '/api/platform/unstake') && request.method === 'POST') {
        const body = await readBody(request);
        const action = pathname === '/api/platform/stake' ? 'stake' : 'unstake';
        await withAccountLock(session.address, () => platformService[action](session.address, body.amount));
        const markPrice = await marketPrice('perp', 'BTC', { allowStale:true }).catch(() => 0);
        send(res, 200, { ok:true, ...platformService.profile(session.address, {BTC:markPrice}, 'BTC') });
        return true;
      }
      send(res, 404, { error:'平台接口不存在', code:'NOT_FOUND' });
      return true;
    } catch (error) {
      sendError(res, error);
      return true;
    }
  }

  return { executeOrder, handle, marketPrice, updateMarket, withAccountLock };
}
