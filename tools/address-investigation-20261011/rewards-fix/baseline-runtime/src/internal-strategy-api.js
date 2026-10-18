export function createInternalStrategyApi({ strategyService, fetchPrices, fetchCandles, analyzeTrend, send, readBody, getSession, withAccountLock }) {
  const keys = new Set(['de', 'ex', 'rs']);
  function keyFrom(pathname) { return String(pathname).split('/')[3]?.toLowerCase(); }
  function publicMarkets(key) {
    return { exchange:'WG Internal', mode:'internal', dataSource:'platform', dataProvider:'internal-ledger', network:'internal', markets:strategyService.markets(key) };
  }
  async function markPrice(symbol = 'BTC') {
    const normalized = String(symbol || 'BTC').toUpperCase().replace(/USDT$/, '');
    try { const map = await fetchPrices([normalized]); return Number(map?.get?.(normalized) ?? map?.values?.().next().value); }
    catch { return 0; }
  }
  async function handle(request, res, pathname) {
    if (pathname === '/api/internal-strategy/summary' && request.method === 'GET') {
      const session = getSession(request);
      if (!session) { send(res, 401, { error:'wallet session required', code:'SESSION_REQUIRED' }); return true; }
      const strategies = strategyService.allFor(session.address);
      send(res, 200, { maxRunning:3, runningCount:Object.values(strategies).filter(item => item.running).length, strategies });
      return true;
    }
    const key = keyFrom(pathname);
    if (!keys.has(key)) return false;
    const subPath = pathname.slice(`/api/internal-strategy/${key}`.length);
    if (subPath === '/markets' && request.method === 'GET') { send(res, 200, publicMarkets(key)); return true; }
    if (subPath === '/trend' && request.method === 'GET') {
      const symbol = String(new URL(request.url, 'http://localhost').searchParams.get('marketId') || 'BTC').toUpperCase().replace(/USDT$/, '');
      const price = await markPrice(symbol);
      let candles = [];
      try { candles = await fetchCandles(symbol, Number(new URL(request.url, 'http://localhost').searchParams.get('intervalSec') || 3600), 120); } catch {}
      const analysis = candles.length >= 20 ? analyzeTrend(candles, { currentPrice:price }) : { trend:'range', recommended:'neutral', strength:0, price, detail:'Internal platform market data' };
      send(res, 200, { analysis, candles }); return true;
    }
    const session = getSession(request);
    if (!session) { send(res, 401, { error:'wallet session required', code:'SESSION_REQUIRED' }); return true; }
    try {
      const stored = strategyService.stateFor(session.address, key);
      const mark = await markPrice(stored.config?.symbol || 'BTC');
      if (subPath === '/state' && request.method === 'GET') { send(res, 200, strategyService.stateFor(session.address, key, mark)); return true; }
      if (subPath === '/start' && request.method === 'POST') { const body = await readBody(request); send(res, 200, await withAccountLock(session.address, () => strategyService.start(session.address, key, body))); return true; }
      if (subPath === '/stop' && request.method === 'POST') { send(res, 200, await withAccountLock(session.address, () => strategyService.stop(session.address, key))); return true; }
      if (subPath === '/adjust' && request.method === 'POST') { const body = await readBody(request); send(res, 200, await withAccountLock(session.address, () => strategyService.adjust(session.address, key, body))); return true; }
      if (subPath === '/cancel-orders' && request.method === 'POST') { send(res, 200, strategyService.stateFor(session.address, key, mark)); return true; }
      if (subPath === '/reconnect' && request.method === 'POST') { send(res, 200, { ok:true, state:strategyService.stateFor(session.address, key, mark) }); return true; }
      if (subPath === '/stream' && request.method === 'GET') {
        res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', Connection:'keep-alive' });
        const write = async () => { try { res.write(`data: ${JSON.stringify(strategyService.stateFor(session.address, key, await markPrice()))}\n\n`); } catch {} };
        write(); const timer = setInterval(write, 2000); request.on('close', () => clearInterval(timer)); return true;
      }
      send(res, 404, { error:'internal strategy endpoint not found', code:'NOT_FOUND' }); return true;
    } catch (error) { send(res, Number(error.statusCode) || 400, { error:error.message || String(error), code:error.code || 'STRATEGY_ERROR' }); return true; }
  }
  return { handle };
}
