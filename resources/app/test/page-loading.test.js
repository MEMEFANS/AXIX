import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const publicDir = path.resolve(import.meta.dirname, '../public');
const address = '0x1271000000000000000000000000000000000ddb';
const profile = { authenticated:true, address, balances:{ USDT:'789', A:'4321.87654321' }, deposits:[], withdrawals:[] };
const platform = { account:{ availableMargin:'789', totalEquity:'1250' }, staking:{ principal:'99', rewards:'8', apy:0.1 }, spot:{ A:'4321.87654321' }, strategy:{}, perps:{}, orders:[], fills:[], capitalHistory:[] };
const aix = { balances:profile.balances, locked:{ usdt:0, a:0 }, miners:[], stakes:[], activations:[], teamLevel:{ level:0 } };
const calls = [], scripts = [], errors = [], held = new Map(), holding = new Set();
const scriptFailures = new Map();
const result = { scenarios:[] };
const browser = await puppeteer.launch({ executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width:390, height:844, isMobile:true, hasTouch:true });
  await page.evaluateOnNewDocument(address => {
    window.walletMethods = [];
    window.ethereum = { request:async ({ method }) => {
      walletMethods.push(method);
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
      if (method === 'eth_chainId') return '0x38';
      if (method === 'personal_sign') return 'TEST_ONLY_SIGNATURE';
      throw new Error('Unexpected wallet method: ' + method);
    }, on() {}, removeListener() {} };
    // Exercise several polling periods in a short regression, without touching real APIs.
    const interval = window.setInterval.bind(window);
    window.setInterval = (fn, ms, ...args) => interval(fn, ms >= 1000 ? 120 : ms, ...args);
    window.mockStreams = [];
    window.EventSource = class {
      static CLOSED = 2;
      constructor(url) {
        this.url = url; this.readyState = 1; mockStreams.push(this);
        if (url.includes('internal-strategy')) setTimeout(() => {
          if (this.readyState !== 2) this.onmessage?.({ data:JSON.stringify({ exchange:url.split('/')[3], running:false, capital:'10', equity:'10', fills:[], alerts:[], stats:{} }) });
        }, 10);
      }
      close() { this.readyState = 2; }
    };
  }, address);
  const respond = (request, data, status = 200) => request.respond({ status, contentType:'application/json', body:JSON.stringify(data) });
  function fixture(url, request) {
    const p = url.pathname;
    if (p === '/api/wallet/login-challenge') return { message:'TEST_ONLY_LOGIN' };
    if (p === '/api/wallet/login-sign') return { ok:true };
    if (p === '/api/wallet/session') return { authenticated:true, address };
    if (p === '/api/wallet/profile') return profile;
    if (p === '/api/wallet/config') return { networks:[] };
    if (p === '/api/a-token/plans') return { activation:[], staking:[], activationEnabled:true };
    if (p === '/api/a-token/team/summary') return { directCount:7, teamCount:40 };
    if (p === '/api/a-token/profile') return aix;
    if (p === '/api/platform/profile') return platform;
    if (p === '/api/market/candles') return { candles:[{ time:Date.now(), open:100, high:101, low:99, close:100, volume:10 }], markPrice:100 };
    if (p === '/api/market/orderbook') return { bids:[], asks:[] };
    if (p === '/api/market/tickers') return { tickers:[] };
    if (p === '/api/internal-strategy/summary') return { strategies:{}, runningCount:0 };
    if (p.endsWith('/markets')) return { mode:'paper', markets:[{ marketId:'BTC', displayName:'BTC/USDT', minOrderSize:0.001 }] };
    if (p.endsWith('/trend')) return { analysis:{ price:100, trend:'range', strength:0.5, recommended:'neutral', detail:'TEST', atr:1 }, candles:[{ time:Date.now(), open:100, high:101, low:99, close:100 }] };
    if (p === '/api/a-token/pool') return { priceUsdt:0.1234, recentTrades:[] };
    if (p === '/api/a-token/orderbook') return { bids:[], asks:[], markPrice:0.1234 };
    if (p === '/api/a-token/orders') return { orders:[] };
    if (p === '/api/a-token/kline') return { candles:[] };
    if (p === '/api/lottery/config') return { prizes:[], pointRules:{} };
    if (p === '/api/lottery/points') return { points:123, flows:[] };
    if (p === '/api/lottery/recent' || p === '/api/lottery/wins' || p === '/api/lottery/leaderboard') return { wins:[] };
    if (p === '/api/referrals/profile') return { code:'TEST', link:'/?ref=TEST', directValid:3, rows:[] };
    if (p === '/api/airdrop/points') return { points:42 };
    if (p === '/api/platform/leaderboard') return { items:[], total:0 };
    if (p === '/api/support/session') return { ticket:{ id:'T', status:'open' }, messages:[] };
    if (p === '/api/ai-managed/state') return { running:false, principal:'75', totalEarned:'9', dayEarned:'1', availableBalance:'789', progress:0, batches:[], records:[] };
    if (p === '/api/community-links') return { links:[] };
    if (p === '/api/ledger') return { items:[], total:0, summary:{ records:0, completed:0, wins:0, losses:0, realizedPnl:0, fees:0 } };
    if (p === '/api/ai/status') return { enabled:false };
    if (p === '/api/hyperliquid/info') {
      const { type } = JSON.parse(request.postData());
      if (type === 'validatorSummaries') return [{ name:'Test validator', stake:100000000, isJailed:false }];
      if (type === 'clearinghouseState') return { marginSummary:{ accountValue:250 }, assetPositions:[{ position:{ coin:'BTC', szi:'0.1', unrealizedPnl:15, entryPx:100, positionValue:10 } }] };
      if (type === 'spotClearinghouseState') return { balances:[{ coin:'USDC', total:37, hold:0 }] };
      if (type === 'vaultSummaries') return [{ vaultAddress:address, name:'Test vault', tvl:100, apr:0.1 }];
      return [];
    }
    return {};
  }
  await page.setRequestInterception(true);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.hostname !== 'pages.test') return request.abort();
    const type = url.pathname === '/api/hyperliquid/info' ? JSON.parse(request.postData()).type : '';
    const key = type || url.pathname;
    if (url.pathname.startsWith('/api/')) {
      calls.push({ key, url:request.url(), method:request.method() });
      if (request.method() !== 'GET' && !type && !key.startsWith('/api/wallet/login-')) { errors.push('Unexpected mutation: ' + key); return request.abort(); }
    }
    if (url.pathname.endsWith('.js')) scripts.push(url.pathname);
    if (scriptFailures.get(key)) { scriptFailures.set(key,scriptFailures.get(key)-1); return request.respond({ status:503,body:'' }); }
    if (holding.has(key)) {
      if (!held.has(key)) held.set(key, []);
      held.get(key).push(request); return;
    }
    if (url.pathname.startsWith('/api/')) return respond(request, fixture(url, request));
    const file = path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!fs.existsSync(file)) return request.respond({ status:404, body:'' });
    const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml' };
    return request.respond({ contentType:mime[path.extname(file)] || 'application/octet-stream', body:fs.readFileSync(file) });
  });
  const count = key => calls.filter(c => c.key === key).length;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function pending(key) {
    for (let i = 0; i < 100 && !held.get(key)?.length; i++) await wait(20);
    assert(held.get(key)?.length, 'Expected pending: ' + key);
  }
  async function release(key, data, status = 200) {
    holding.delete(key);
    const batch = held.get(key) || []; held.delete(key);
    await Promise.all(batch.map(request => key.endsWith('.js')
      ? request.respond({ contentType:'text/javascript', body:fs.readFileSync(path.join(publicDir,key)) })
      : respond(request, data ?? fixture(new URL(request.url()),request),status)));
  }
  const visit = name => page.evaluate(name => switchTab(name), name);
  const contains = async (selector, text) => {
    try { await page.waitForFunction((selector, text) => document.querySelector(selector)?.textContent.includes(text), { timeout:6000 }, selector, text); }
    catch (error) { console.log(JSON.stringify({ selector, text, errors, recentCalls:calls.slice(-8), dom:await page.$eval(selector,n=>n.textContent.slice(0,2200)).catch(()=>null) })); throw error; }
  };
  const mark = name => { result.scenarios.push(name); console.log('PASS: ' + name); };

  await page.goto('http://pages.test/', { waitUntil:'domcontentloaded' });
  await page.waitForFunction(() => currentWalletProfile?.authenticated && !Portal.pages.earn.loading, { timeout:6000 }).catch(async error => {
    console.log(JSON.stringify({ errors, calls, state:await page.evaluate(() => ({ wallet:window.currentWalletProfile, connection:window.currentWalletConnection, methods:walletMethods, page:Portal.pages.earn })) }));
    throw error;
  });
  assert(!scripts.includes('/vendor/lightweight-charts.js'));
  mark('miner startup loads only miner data');

  holding.add('/vendor/lightweight-charts.js');
  await page.evaluate(() => { window.pendingTrade = switchTab('trade'); });
  await pending('/vendor/lightweight-charts.js');
  await contains('#trade-mark-price','100');
  await contains('#trade-available-balance','789');
  assert.equal(await page.$('#trade-chart canvas'),null);
  await page.evaluate(() => { setTradeEma(7,true); setTradeBoll(true); });
  mark('trading price and available balance render before chart library');
  const started = Date.now();
  await visit('overview');
  await contains('#tot-equity', '0');
  result.overviewWithChartHeldMs = Date.now() - started;
  assert(!calls.some(c => /internal-strategy\/(de|ex|rs)\/(markets|trend)/.test(c.url)));
  mark('slow chart cannot block overview or start other strategies');

  holding.add('/api/wallet/profile'); holding.add('/api/platform/profile');
  await visit('account');
  await pending('/api/wallet/profile'); await pending('/api/platform/profile');
  assert.equal(count('/api/wallet/config'),0);
  assert(!scripts.some(s => /a-token-(transfer|withdrawal)\.js/.test(s)));
  await release('/api/wallet/profile');
  await contains('#assets-table-body','4,321.87654321');
  assert(held.get('/api/platform/profile')?.length);
  await release('/api/platform/profile');
  await contains('#assets-total-equity','1,250');
  mark('wallet balances display while valuation waits; funding/modal code stays lazy');

  scriptFailures.set('/js/a-token-transfer.js',1);
  await page.evaluate(() => ExchangeAssets.openAix('transfer'));
  await contains('#app-toast','网络连接失败');
  await page.evaluate(() => ExchangeAssets.openAix('transfer'));
  await page.waitForSelector('#atoken-transfer-modal.awd-show');
  await page.evaluate(() => ATokenTransfer.close());
  assert.equal(scripts.filter(s=>s==='/js/a-token-transfer.js').length,2);
  mark('optional modal download failure can be retried without blocking balances');

  holding.add('/api/a-token/profile');
  await visit('a-token-trade'); await pending('/api/a-token/profile');
  await contains('.atrade-spot-price-strip','$0.1234');
  assert(held.get('/vendor/lightweight-charts.js')?.length);
  assert.equal(count('/api/a-token/orders'),0);
  await release('/api/a-token/profile');
  await contains('#atrade-account-content','4,321.8765');
  await release('/vendor/lightweight-charts.js');
  await page.evaluate(() => pendingTrade);
  assert.equal(await page.$eval('.tab-panel.active',n=>n.id),'tab-a-token-trade');
  await page.waitForFunction(() => document.querySelector('#atrade-chart')?.querySelector('canvas'));
  mark('AIX price renders before profile/chart; order history loads on its tab');
  await visit('trade');
  await page.waitForFunction(() => tradeCandleData.length > 0 && !!tradeCandleSeries);
  assert.equal(await page.evaluate(() => tradeCandleData.at(-1).close),100);
  assert.equal(await page.evaluate(() => tradeEmaSeries.get(7).options().visible),true);
  assert.equal(await page.evaluate(() => tradeBollUpper.options().visible),true);
  mark('deferred trading chart receives real candle data when ready');

  await visit('support'); await contains('#support-chat-content','客服');
  await wait(250);
  holding.add('/api/lottery/config'); holding.add('/api/lottery/points');
  await visit('points');
  await pending('/api/lottery/config'); await pending('/api/lottery/points');
  await page.waitForSelector('.lottery-wrap');
  const supportCalls = count('/api/support/session'), aixCalls = count('/api/a-token/orderbook');
  await release('/api/lottery/points'); await contains('#lottery-pts-num','123');
  assert(await page.$eval('#fruit-start',n=>n.disabled));
  await release('/api/lottery/config');
  await page.waitForFunction(() => !document.getElementById('fruit-start').disabled);
  await wait(400);
  assert.equal(count('/api/support/session'),supportCalls);
  assert.equal(count('/api/a-token/orderbook'),aixCalls);
  mark('lottery sections render independently; hidden support/AIX polling stops');

  holding.add('/api/lottery/leaderboard');
  await page.evaluate(() => switchLotteryTab('leaderboard')); await pending('/api/lottery/leaderboard');
  await page.evaluate(() => switchLotteryTab('points')); await contains('#lottery-tab-content','当前积分');
  await release('/api/lottery/leaderboard'); await wait(100);
  await contains('#lottery-tab-content','当前积分');
  mark('late lottery subtab response cannot overwrite current tab');

  holding.add('/api/airdrop/points');
  await visit('referrals'); await pending('/api/airdrop/points'); await contains('#referrals-content','3 人');
  await release('/api/airdrop/points'); await contains('#airdrop-metrics','42');
  const marqueeCalls = count('/api/lottery/recent'); await wait(400);
  assert.equal(count('/api/lottery/recent'),marqueeCalls);
  await visit('leaderboard'); await contains('#leaderboard-content','合约跟单收益排名');
  mark('referrals render before airdrop; leaderboard isolated; hidden lottery stops');

  holding.add('validatorSummaries');
  await visit('staking'); await pending('validatorSummaries'); await contains('#staking-platform','99');
  await page.$eval('#platform-stake-amount',n=>n.value='12.5');
  await release('validatorSummaries',{ error:'TEST_VALIDATORS_UNAVAILABLE' },503);
  assert.equal(await page.$eval('#platform-stake-amount',n=>n.value),'12.5');
  await contains('#staking-validators','TEST_VALIDATORS_UNAVAILABLE');
  mark('staking and validator failures are independent; amount input preserved');

  holding.add('spotClearinghouseState'); holding.add('userVaultEquities');
  await visit('portfolio'); await pending('spotClearinghouseState'); await pending('userVaultEquities');
  await contains('#portfolio-content','BTC');
  await release('spotClearinghouseState'); await contains('#portfolio-content','USDC');
  await release('userVaultEquities',{ error:'TEST_VAULTS_UNAVAILABLE' },503);
  await contains('#portfolio-content','BTC');
  await visit('vaults'); await contains('#vaults-content','Test vault');
  assert.equal(scripts.filter(s=>s==='/js/hyperliquid-client.js').length,1);
  mark('portfolio results display progressively; vault failure preserves assets');

  await visit('ai-managed'); await contains('#aim-total-earned','9');
  await visit('ledger'); await contains('#ledger-records','0');
  const copyCalls = count('/api/ai-managed/state'); await wait(400);
  assert.equal(count('/api/ai-managed/state'),copyCalls);
  await visit('ai'); await page.waitForFunction(() => window._aiCfgFilled);
  await visit('community'); await contains('#community-links-grid','社群入口');
  const aiCalls = count('/api/ai/status'); await wait(400); assert.equal(count('/api/ai/status'),aiCalls);
  await visit('whitepaper');
  mark('copy-trade, ledger, AI, community, whitepaper load on demand; hidden AI polls stop');

  for (const name of ['de','ex','rs']) {
    await visit(name);
    await contains(`#${name}-capital-available`,'789');
    const live = await page.evaluate(() => mockStreams.filter(s=>s.readyState!==2 && s.url.includes('internal-strategy')).map(s=>s.url));
    assert.deepEqual(live,[`/api/internal-strategy/${name}/stream`]);
  }
  await visit('earn');
  assert.equal(await page.evaluate(() => mockStreams.filter(s=>s.readyState!==2 && s.url.includes('internal-strategy')).length),0);
  mark('only selected strategy opens a stream; leaving closes all strategy streams');

  holding.add('/api/ledger');
  await visit('ledger'); await pending('/api/ledger');
  await page.evaluate(() => { document.getElementById('ledger-exchange').value='ex'; loadLedger(true); });
  for (let i=0; i<100 && held.get('/api/ledger')?.length<2; i++) await wait(10);
  const ledgerPending = held.get('/api/ledger');
  assert.equal(ledgerPending.length,2);
  const ledgerData = tag => ({ items:[{ exchange:tag,market:tag.toUpperCase(),t:Date.now(),kind:'open',side:'buy',price:1,size:1 }],total:1,summary:{ records:1,completed:0,wins:0,losses:0,realizedPnl:0,fees:0 } });
  holding.delete('/api/ledger'); held.delete('/api/ledger');
  await respond(ledgerPending[1],ledgerData('ex')); await contains('#ledger-body','EX');
  await respond(ledgerPending[0],ledgerData('de')); await wait(100);
  assert.equal(await page.evaluate(() => ledgerOffset),1);
  assert(!(await page.$eval('#ledger-body',n=>n.textContent)).includes('DE'));
  mark('old ledger filter responses cannot overwrite the current result or offset');

  await visit('portfolio');
  holding.add('clearinghouseState');
  await page.evaluate(() => { Portal.load('portfolio',true); }); await pending('clearinghouseState');
  const addressB = '0x2342000000000000000000000000000000000eec';
  await page.evaluate(address => {
    window.currentWalletConnection={address}; window.currentWalletProfile={authenticated:true,address};
    Portal.invalidate(); Portal.load('portfolio',true);
  },addressB);
  for (let i=0;i<100&&held.get('clearinghouseState')?.length<2;i++)await wait(10);
  const wallets = held.get('clearinghouseState'); assert.equal(wallets.length,2);
  holding.delete('clearinghouseState'); held.delete('clearinghouseState');
  await respond(wallets[1],{ marginSummary:{accountValue:9999},assetPositions:[] }); await contains('#portfolio-content','9,999');
  await respond(wallets[0],{ marginSummary:{accountValue:1111},assetPositions:[] }); await wait(100);
  await contains('#portfolio-content','9,999');
  assert(!(await page.$eval('#portfolio-content',n=>n.textContent)).includes('1,111'));
  mark('pending requests are isolated across wallets; old balances cannot overwrite new ones');

  holding.add('/api/test-read');
  await page.evaluate(() => { window.testReads=Promise.all([Portal.readJSON('/api/test-read'),Portal.readJSON('/api/test-read'),Portal.readJSON('/api/test-read')]); });
  await pending('/api/test-read'); assert.equal(held.get('/api/test-read').length,1);
  await release('/api/test-read',{ok:true}); assert.deepEqual(await page.evaluate(() => testReads),[{ok:true},{ok:true},{ok:true}]);
  holding.add('/api/test-hang');
  const timeoutError = await page.evaluate(() => Portal.readJSON('/api/test-hang',{timeoutMs:80}).catch(error=>error.message));
  assert.match(timeoutError,/超时/);
  mark('simultaneous reads coalesce; hung reads fail within their deadline');

  assert.deepEqual(errors,[]);
  assert(!(await page.evaluate(() => walletMethods)).includes('eth_sendTransaction'));
  result.scriptCount = scripts.length;
  fs.mkdirSync(path.resolve(import.meta.dirname,'../tools/page-loading-20261011'),{recursive:true});
  fs.writeFileSync(path.resolve(import.meta.dirname,'../tools/page-loading-20261011/browser-result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
