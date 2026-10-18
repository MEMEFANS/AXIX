import assert from 'node:assert/strict';
import { fetchFuturesCandles, fetchFuturesOrderBook, fetchFuturesPrices, fetchFuturesTickers, fetchPublicOrderBook, fetchPublicTickers, parsePublicPriceMessage, resetPublicMarketDataCache } from '../src/market-data/public.js';

const payload = {
  lastUpdateId:1,
  bids:[['60000', '1.25']],
  asks:[['60001', '0.75']],
};
let calls = 0;
const fetchImpl = async () => {
  calls += 1;
  return { ok:true, json:async () => payload };
};

resetPublicMarketDataCache();
const [first, second] = await Promise.all([
  fetchPublicOrderBook('BTC', { fetchImpl, baseUrl:'https://test.local/info' }),
  fetchPublicOrderBook('BTC', { fetchImpl, baseUrl:'https://test.local/info' }),
]);
assert.equal(calls, 1, '并发订单簿请求应复用同一个上游请求');
assert.deepEqual(first, second);
assert.equal(first.bids[0].price, 60_000);

await fetchPublicOrderBook('BTC', { fetchImpl, baseUrl:'https://test.local/info' });
assert.equal(calls, 1, '缓存有效期内不能重复请求上游');

const futuresFetch = async url => {
  if (url.includes('premiumIndex')) return { ok:true, json:async()=>({symbol:'XRPUSDT',markPrice:'1.0126'}) };
  if (url.includes('klines')) return { ok:true, json:async()=>Array.from({length:20},(_,i)=>[i*60_000,'76','77','75','76.5','100']) };
  return { ok:true, json:async()=>payload };
};
const futuresPrices=await fetchFuturesPrices(['XRP'],{fetchImpl:futuresFetch,baseUrl:'https://futures.test'});
assert.equal(futuresPrices.get('XRPUSDT'),1.0126);
assert.equal((await fetchFuturesCandles('SOL',60,20,{fetchImpl:futuresFetch,baseUrl:'https://futures.test'})).length,20);
assert.equal((await fetchFuturesOrderBook('XRP',{fetchImpl:futuresFetch,baseUrl:'https://futures.test'})).bids[0].price,60_000);
assert.equal(parsePublicPriceMessage(JSON.stringify({e:'markPriceUpdate',E:1,s:'XRPUSDT',p:'1.0126'})).price,1.0126);
assert.equal(parsePublicPriceMessage(JSON.stringify({e:'markPriceUpdate',E:1,s:'XRPUSDT',p:'1.0126'})).priceType,'mark');
assert.equal(parsePublicPriceMessage(JSON.stringify({e:'trade',E:2,s:'BTCUSDT',p:'63500'})).priceType,'trade');

const tickerPayload = [
  {symbol:'BTCUSDT',lastPrice:'63500',priceChangePercent:'1.25',highPrice:'64000',lowPrice:'62000',volume:'1200',quoteVolume:'76000000'},
  {symbol:'ETHUSDT',lastPrice:'1900',priceChangePercent:'-0.50',highPrice:'1950',lowPrice:'1850',volume:'2500',quoteVolume:'4750000'},
];
const tickerFetch = async () => ({ ok:true, json:async () => tickerPayload });
const spotTickers = await fetchPublicTickers(['BTC','ETH'], { fetchImpl:tickerFetch, baseUrl:'https://spot.test' });
const perpTickers = await fetchFuturesTickers(['BTC','ETH'], { fetchImpl:tickerFetch, baseUrl:'https://futures.test' });
assert.deepEqual(spotTickers.map(item => item.symbol), ['BTC','ETH']);
assert.equal(spotTickers[0].price, 63500);
assert.equal(spotTickers[1].changePercent, -0.5);
assert.equal(spotTickers[0].highPrice, 64000);
assert.equal(spotTickers[0].quoteVolume, 76000000);
assert.equal(perpTickers[0].volume, 1200);
resetPublicMarketDataCache();
console.log('market-data tests passed');
