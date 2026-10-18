import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const publicDir = path.resolve(import.meta.dirname, '../public');
const address = '0x1271000000000000000000000000000000000ddB';
const browser = await puppeteer.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true});
const plans = {activation:[{plan:'1',bnb:'0.002',label:'Mini 矿机'}],staking:[],activationEnabled:true};

async function openScenario({failures = 1, holdPlans = false, rejectSign = false} = {}) {
  const page = await browser.newPage();
  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  const state = {failures,authenticated:false,requests:[],challenges:[],errors:[],heldPlans:null};
  page.on('pageerror', error => state.errors.push(error.message));
  await page.evaluateOnNewDocument(({address,rejectSign}) => {
    window.testMethods = [];
    window.testToasts = [];
    window.testRejectSign = rejectSign;
    window.ethereum = {
      request:async ({method}) => {
        testMethods.push(method);
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
        if (method === 'eth_chainId') return '0x38';
        if (method === 'personal_sign') {
          if (testRejectSign) throw Object.assign(new Error('User rejected'), {code:4001});
          return 'TEST_ONLY_SIGNATURE';
        }
        throw new Error('Unexpected wallet operation: ' + method);
      },
      on:() => {}, removeListener:() => {},
    };
  }, {address,rejectSign});
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.hostname !== 'auth.test') return request.abort();
    state.requests.push(url.pathname);
    const json = (data,status=200) => request.respond({status,contentType:'application/json',body:JSON.stringify(data)});
    if (url.pathname === '/api/wallet/login-challenge') {
      state.challenges.push(JSON.parse(request.postData()));
      if (state.failures-- > 0) return request.abort('failed');
      return json({message:'TEST_ONLY_LOGIN'});
    }
    if (url.pathname === '/api/wallet/login-sign') {state.authenticated=true; return json({ok:true,address});}
    if (url.pathname === '/api/wallet/session') return json(state.authenticated ? {authenticated:true,address} : {authenticated:false});
    if (url.pathname === '/api/wallet/profile') throw new Error('Full funding/RPC profile must not be requested by miner startup');
    if (url.pathname === '/api/a-token/plans') {
      if (state.rejectPlans) return json({error:'TEST_PLANS_UNAVAILABLE'},503);
      if (holdPlans && !state.heldPlans) {state.heldPlans=request;return;}
      return json(plans);
    }
    if (url.pathname === '/api/a-token/profile') return json({userId:'TEST',balances:{A:'0'},miners:[],activations:[],stakes:[]});
    if (url.pathname.startsWith('/api/')) return json({directs:[],TEAM_LEVELS:[],code:'TEST'});
    const file = path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!fs.existsSync(file)) return request.respond({status:404,body:''});
    const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
    return request.respond({contentType:types[path.extname(file)] || 'application/octet-stream',body:fs.readFileSync(file)});
  });
  await page.goto('http://auth.test/', {waitUntil:'domcontentloaded'});
  await page.evaluate(() => { const original=window.showToast; window.showToast=(message,...args)=>{testToasts.push(message);return original(message,...args);}; });
  return {page,state};
}

try {
  const start = Date.now();
  const {page,state} = await openScenario({failures:1,holdPlans:true});
  await page.waitForFunction(() => currentWalletProfile?.authenticated && document.querySelector('.btn-activate'), {timeout:4000});
  assert(state.heldPlans, 'The plans response is still pending while the cards and login are already visible');
  assert.equal(state.challenges.length,2);
  assert.equal(state.challenges[0].requestId,state.challenges[1].requestId);
  assert.equal(await page.evaluate(() => testMethods.filter(m => m === 'personal_sign').length),1);
  assert(!state.requests.includes('/api/a-token/team/profile') && !state.requests.includes('/api/referrals/profile'));
  assert(!state.requests.includes('/api/wallet/profile'));
  const readyMs = Date.now()-start;
  await state.heldPlans.respond({contentType:'application/json',body:JSON.stringify(plans)});
  await page.evaluate(() => {window.testWalks=0;const original=document.createTreeWalker.bind(document);document.createTreeWalker=(...args)=>{++testWalks;return original(...args);};document.getElementById('hdr-time').textContent='12:34:56';});
  await new Promise(resolve => setTimeout(resolve,200));
  assert.equal(await page.evaluate(() => testWalks),0,'Chinese clock mutations must not trigger a whole-page translation scan');
  state.rejectPlans = true;
  await page.evaluate(() => earnActivate('1'));
  assert.equal(await page.evaluate(() => testMethods.includes('eth_sendTransaction')),false,'Cached/fallback cards must never authorize payment while current plans cannot be checked');
  state.rejectPlans = false;
  await page.evaluate(() => earnSwitch('team'));
  await page.waitForFunction(() => !!document.querySelector('#earn-content .btn-copy:not([disabled])'));
  assert(state.requests.includes('/api/a-token/team/profile') && state.requests.includes('/api/referrals/profile'));
  assert.equal(await page.evaluate(() => testMethods.includes('eth_sendTransaction')),false);
  assert.deepEqual(state.errors,[]);
  await page.close();

  const retry = await openScenario({failures:2});
  await retry.page.waitForFunction(() => !connectorRestoring && !!currentWalletConnection?.address, {timeout:8000});
  assert.equal(await retry.page.evaluate(() => testMethods.includes('personal_sign')),false);
  assert.equal(retry.state.challenges.length,2,'Automatic retry is bounded');
  await retry.page.click('#wallet-connect-btn');
  await retry.page.waitForFunction(() => currentWalletProfile?.authenticated);
  assert.equal(await retry.page.evaluate(() => testMethods.filter(m => m === 'personal_sign').length),1,'Clicking the displayed address directly retries identity verification');
  assert.deepEqual(retry.state.errors,[]);
  await retry.page.close();

  const cancelled = await openScenario({failures:0,rejectSign:true});
  await cancelled.page.waitForFunction(() => !connectorRestoring && !!currentWalletConnection?.address);
  assert.equal(await cancelled.page.evaluate(() => testMethods.filter(m => m === 'personal_sign').length),1,'A cancelled signature must not be automatically repeated');
  await cancelled.page.evaluate(() => {testRejectSign=false;});
  await cancelled.page.click('.earn-wallet-hint button');
  await cancelled.page.waitForFunction(() => currentWalletProfile?.authenticated);
  assert.equal(await cancelled.page.evaluate(() => testMethods.filter(m => m === 'personal_sign').length),2);
  assert.deepEqual(cancelled.state.errors,[]);
  await cancelled.page.close();
  console.log(`PASS: transient challenge retry with one signature; login/cards ready in ${readyMs} ms with plans held; light cookie session; bounded failures/manual retry; cancellation respected; team loaded on demand; no Chinese clock DOM scan; no transactions`);
} finally {await browser.close();}
