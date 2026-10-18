import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const publicDir = path.resolve(import.meta.dirname, '../public');
const address = '0x1271000000000000000000000000000000000ddB';
const browser = await puppeteer.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try {
  const page = await browser.newPage();
  await page.setViewport({width:390,height:1200,isMobile:true,hasTouch:true});
  const errors = [], apiRequests = [], scriptRequests = [];
  let authenticated = false, heldChart, heldConfig;
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluateOnNewDocument(address => {
    const listeners = new Map();
    window.testMethods = [];
    window.testAccountReads = 0;
    window.ethereum = {
      request:async ({method}) => {
        testMethods.push(method);
        if (method === 'eth_accounts') return ++testAccountReads === 1 ? [] : [address];
        if (method === 'eth_requestAccounts') return [address];
        if (method === 'eth_chainId') return '0x38';
        if (method === 'personal_sign') return 'TEST_ONLY_SIGNATURE';
        throw new Error('Unexpected wallet request: ' + method);
      },
      on:(name, listener) => listeners.set(name, listener),
      removeListener:name => listeners.delete(name),
    };
  }, address);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.hostname !== 'mobile.test') return request.abort();
    if (url.pathname.endsWith('.js')) scriptRequests.push(url.pathname);
    const json = data => request.respond({contentType:'application/json',body:JSON.stringify(data)});
    if (url.pathname === '/vendor/lightweight-charts.js') { heldChart = request; return; }
    if (url.pathname.startsWith('/api/')) {
      apiRequests.push(url.pathname);
      if (url.pathname === '/api/wallet/config') { heldConfig=request; return; }
      if (url.pathname === '/api/wallet/login-challenge') return json({message:'TEST_ONLY_LOGIN'});
      if (url.pathname === '/api/wallet/login-sign') { authenticated = true; return json({ok:true}); }
      if (request.method() !== 'GET') return request.abort();
      if (url.pathname === '/api/wallet/profile') return json(authenticated ? {authenticated:true,address,balances:{USDT:'0'},deposits:[],withdrawals:[]} : {authenticated:false});
      if (url.pathname === '/api/wallet/session') return json(authenticated ? {authenticated:true,address} : {authenticated:false});
      if (url.pathname === '/api/a-token/plans') return json({activation:[{plan:'1',bnb:'0.002',label:'Mini 矿机'}],staking:[],activationEnabled:true});
      if (url.pathname === '/api/a-token/profile') return json({userId:'TEST',balances:{A:'0'},miners:[],activations:[],stakes:[]});
      if (url.pathname === '/api/a-token/team/profile') return json({directs:[],TEAM_LEVELS:[]});
      if (url.pathname === '/api/referrals/profile') return json({code:'TEST',link:'/?ref=TEST'});
      if (url.pathname === '/api/platform/profile') return json({account:{},strategy:{},spot:{},perps:{},orders:[],fills:[]});
      if (url.pathname === '/api/market/catalog') return json({markets:[]});
      return json({});
    }
    const file = path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!fs.existsSync(file)) return request.respond({status:404,body:''});
    const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
    return request.respond({contentType:types[path.extname(file)] || 'application/octet-stream',body:fs.readFileSync(file)});
  });
  const startupStart = Date.now();
  await page.goto('http://mobile.test/', {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => currentWalletProfile?.authenticated && document.querySelector('.btn-activate')?.textContent.includes('立即激活'), {timeout:6000});
  assert.equal(heldChart,undefined, 'Miner startup must not even request the chart bundle.');
  assert.equal(heldConfig,undefined, 'Miner startup does not need funding configuration.');
  assert.equal(scriptRequests.length,8,scriptRequests.join(', '));
  assert(!apiRequests.includes('/api/wallet/profile'), 'Signing does not wait for full funding history or RPC reconciliation.');
  assert(!apiRequests.includes('/api/a-token/team/profile') && !apiRequests.includes('/api/referrals/profile'), 'Team data is loaded on the team tab.');
  assert(!scriptRequests.some(src => /lottery|strategy|ai-managed|assets|trade-chart/.test(src)));
  assert.equal(await page.evaluate(() => testMethods.filter(method => method === 'personal_sign').length),1);
  assert.equal(await page.evaluate(() => testMethods.includes('wallet_switchEthereumChain')),false);
  assert.equal(await page.evaluate(() => testMethods.includes('eth_sendTransaction')),false);
  assert.match(await page.$eval('#wallet-connect-btn', button => button.textContent),/^0x1271/);
  const startupMs = Date.now()-startupStart;

  // Balances do not wait for funding configuration; only opening the form requests it.
  await page.evaluate(() => { window.testAccountOpen = switchTab('account'); });
  await page.waitForFunction(() => !!window.ExchangeAssets);
  await page.evaluate(() => testAccountOpen);
  assert.equal(heldConfig,undefined);
  await page.evaluate(() => { window.testFundingOpen = ExchangeAssets.openFunding('deposit'); });
  for(let i=0;!heldConfig&&i<30;i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert(heldConfig);
  assert.equal(heldChart,undefined);
  await heldConfig.respond({status:503,contentType:'application/json',body:'{"error":"TEST_CONFIG_UNAVAILABLE"}'});
  await page.evaluate(() => testAccountOpen);
  await page.evaluate(() => switchTab('earn'));

  // Open trade, then immediately leave while its chart download is pending.
  await page.evaluate(() => { window.testTradeOpen = openTradePage('perp'); });
  for(let i=0;!heldChart&&i<30;i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert(heldChart);
  await page.evaluate(() => switchTab('earn'));
  await new Promise(resolve => setTimeout(resolve,100));
  const hiddenMarketRequests = apiRequests.filter(url => /^\/api\/market\/(candles|orderbook|stream|tickers)/.test(url));
  await heldChart.respond({contentType:'text/javascript',body:fs.readFileSync(path.join(publicDir,'vendor/lightweight-charts.js'))});
  await page.waitForFunction(() => window.__tradeDeferredReady);
  await page.evaluate(() => testTradeOpen);
  assert.equal(await page.evaluate(() => document.querySelector('.tab-panel.active').id),'tab-earn');
  await page.evaluate(() => Promise.all([refreshTradeTerminal(), refreshTradeOrderBook(), refreshTradeMarketOverview()]));
  await page.evaluate(() => initTradeMarketStream());
  assert.deepEqual(apiRequests.filter(url => /^\/api\/market\/(candles|orderbook|stream|tickers)/.test(url)),hiddenMarketRequests);
  assert.equal(await page.evaluate(() => !!currentWalletProfile?.authenticated),true);
  // The same market refresh must work when the trading page is selected.
  await page.evaluate(() => openTradePage('perp'));
  await page.evaluate(() => Promise.all([refreshTradeTerminal(), refreshTradeOrderBook(), refreshTradeMarketOverview()]));
  assert(apiRequests.includes('/api/market/candles') && apiRequests.includes('/api/market/orderbook') && apiRequests.includes('/api/market/tickers'));
  assert.equal(await page.evaluate(() => tradeProduct),'perp');
  await page.evaluate(() => switchTab('earn'));
  assert.equal(scriptRequests.filter(src=>src==='/vendor/lightweight-charts.js').length,1);
  assert.equal(scriptRequests.filter(src=>src==='/js/trade-account.js').length,1);
  // First visits also load the other public modules without missing shared dependencies.
  for (const name of ['points','ai-managed','overview','a-token-trade','referrals','leaderboard','community','support']) {
    await page.evaluate(name => loadPageModule(name), name);
  }
  assert.equal(scriptRequests.filter(src=>src==='/vendor/lightweight-charts.js').length,1);
  assert.equal(scriptRequests.filter(src=>src==='/js/platform-client.js').length,1);
  assert(await page.evaluate(() => waitForInjectedProvider(800).then(() => true)), 'An already injected provider must not hit a timer temporal-dead-zone');
  await page.evaluate(() => { window.ethereum = null; window.testInjection = waitForInjectedProvider(800); });
  await page.evaluate(() => { window.ethereum = {request:async () => []}; window.dispatchEvent(new Event('ethereum#initialized')); });
  await page.evaluate(() => testInjection);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.resolve(import.meta.dirname,'../../../tools/wallet-state-audit/按页加载-矿机首屏.png')});
  console.log('PASS: 8 startup scripts, cold wallet accounts, one signature, lightweight login, BSC fast path, account without charts, lazy trading chart, shared scripts load once, navigation race, no hidden-market polling or transactions');
  console.log('Simulated mobile startup reached authenticated UI in ' + startupMs + ' ms with no chart/config requests.');
} finally { await browser.close(); }
