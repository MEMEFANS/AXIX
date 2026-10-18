import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const publicDir = path.resolve(import.meta.dirname, '../public');
const addressA = '0x1271000000000000000000000000000000000ddB';
const addressB = '0x2342000000000000000000000000000000000eeC';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let authenticated = false;
  let loginSubmissions = 0;
  let holdProfile = false, heldProfile;
  let holdPlatform = false, heldPlatform;
  let holdEarn = false;
  const heldEarn = [];
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.hostname !== 'wallet.test') return request.abort();
    const json = payload => request.respond({contentType:'application/json',body:JSON.stringify(payload)});
    if (url.pathname === '/') return request.respond({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><body>
      <button id="wallet-connect-btn">连接钱包</button><button id="wallet-menu-auth"></button><div id="wallet-account-menu" hidden></div>
      <div id="account-locked"><h2></h2><p></p></div><div id="account-content"></div><span id="account-address"></span>
      <div id="tab-earn" class="portal-page active"></div>
      <script>
        window.$=id=>document.getElementById(id);window.showToast=()=>{};
        window.testRejectSign=true;window.testRequests=[];
        window.testProvider={request:async args=>{
          testRequests.push(args.method);
          if(args.method==='personal_sign'){
            if(testRejectSign)throw Object.assign(new Error('User rejected'),{code:4001});
            if(window.testHoldSign)return new Promise(resolve=>{window.testFinishSign=resolve});
            return 'TEST_SIGNATURE';
          }
          throw new Error('Unexpected provider method: '+args.method);
        }};
        window.WGWalletConnector={initialize:async()=>{},onChange:fn=>{window.testOnChange=fn},
          restore:()=>new Promise(resolve=>{window.testRestore=resolve}),switchChain:async()=>56,
          getConnection:()=>({address:window.currentWalletConnection?.address,provider:testProvider})};
      </script>
      <script src="/js/portal-shared.js"></script><script src="/js/i18n.js"></script>
      <script src="/js/earn.js"></script><script src="/js/platform-client.js"></script><script src="/js/wallet.js"></script>
      <script>Portal.load('earn');</script>
    </body>`});
    if (url.pathname.startsWith('/js/')) return request.respond({contentType:'text/javascript; charset=utf-8',body:fs.readFileSync(path.join(publicDir, url.pathname),'utf8')});
    if (url.pathname === '/api/a-token/plans') return json({activation:[{plan:'1',bnb:'0.002',label:'Mini 矿机'}],staking:[],activationEnabled:true});
    if (url.pathname === '/api/wallet/login-challenge') return json({message:'TEST_LOGIN'});
    if (url.pathname === '/api/wallet/login-sign') { ++loginSubmissions; authenticated=true; return json({ok:true}); }
    if (url.pathname === '/api/wallet/session') return json(authenticated ? {authenticated:true,address:addressA} : {authenticated:false});
    if (url.pathname === '/api/wallet/profile') {
      if (holdProfile) {holdProfile=false;heldProfile=request;return;}
      return json(authenticated ? {authenticated:true,address:addressA,balances:{USDT:'0'}} : {authenticated:false});
    }
    if (url.pathname === '/api/platform/profile') {
      if (holdPlatform) {holdPlatform=false;heldPlatform=request;return;}
      return json({account:{},spot:{},perps:{},orders:[]});
    }
    if (url.pathname === '/api/a-token/profile' || url.pathname === '/api/a-token/team/profile' || url.pathname === '/api/referrals/profile') {
      if (holdEarn) {heldEarn.push(request);return;}
      return json({activations:[],miners:[],stakes:[],balances:{A:'0'},userId:'TEST',directs:[],TEAM_LEVELS:[]});
    }
    return request.respond({status:204,body:''});
  });
  await page.goto('http://wallet.test/', {waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('.btn-activate')?.textContent==='连接钱包后激活' && !!window.testRestore);

  // Restore exposes an address while its signature is cancelled, matching the reported screenshot.
  await page.evaluate(address=>testRestore({address,provider:testProvider,label:'Test Wallet'}),addressA);
  await page.waitForFunction(()=>!connectorRestoring && document.querySelector('.btn-activate')?.textContent==='钱包已连接 · 确认身份后激活');
  assert.match(await page.$eval('#wallet-connect-btn',e=>e.textContent),/^0x1271/);
  assert.equal(await page.evaluate(()=>!!currentWalletProfile?.authenticated),false);
  assert.match(await page.$eval('#earn-content',e=>e.textContent),/请在钱包中确认身份/);

  // A delayed pre-login response must not clear a newer successful login.
  holdProfile=true;
  holdPlatform=true;
  await page.evaluate(()=>{window.testProfileRequest=loadWalletProfile();});
  await page.evaluate(()=>{window.testPlatformRequest=PlatformClient.profile().catch(error=>error.status);});
  for(let i=0;!heldProfile&&i<20;i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert(heldProfile);
  for(let i=0;!heldPlatform&&i<20;i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert(heldPlatform);
  holdEarn=true;
  await page.evaluate(()=>{testRejectSign=false;});
  await page.click('.btn-activate');
  await page.waitForFunction(()=>currentWalletProfile?.authenticated && document.querySelector('.btn-activate')?.textContent.includes('立即激活'));
  assert.equal(await page.$eval('.btn-activate',e=>e.getAttribute('onclick')),"window.earnActivate('1')");
  await heldProfile.respond({status:401,contentType:'application/json',body:JSON.stringify({authenticated:false})});
  await page.evaluate(()=>window.testProfileRequest);
  assert.equal(await page.evaluate(()=>!!currentWalletProfile?.authenticated),true);
  await heldPlatform.respond({status:401,contentType:'application/json',body:JSON.stringify({error:'EXPIRED_SESSION'})});
  assert.equal(await page.evaluate(()=>window.testPlatformRequest),401);
  assert.equal(await page.evaluate(()=>!!currentWalletProfile?.authenticated),true);

  // Disconnect while personal-data requests are pending: late responses must not restore the old view.
  await page.evaluate(()=>renderWalletDisconnected());
  await page.waitForFunction(()=>document.querySelector('.btn-activate')?.textContent==='连接钱包后激活');
  holdEarn=false;
  for(const request of heldEarn)await request.respond({contentType:'application/json',body:JSON.stringify({activations:[{plan:'1',status:'confirmed'}],miners:[],stakes:[],userId:'OLD_WALLET'})});
  await page.waitForFunction(()=>!Portal.pages.earn.loading);
  assert.equal(await page.$eval('.btn-activate',e=>e.textContent),'连接钱包后激活');

  // An address switch invalidates the previous platform identity and all cached personal records.
  await page.evaluate(address=>renderWalletConnection({address,provider:testProvider}),addressB);
  assert.equal(await page.evaluate(()=>currentWalletProfile),null);
  await page.waitForFunction(()=>document.querySelector('.btn-activate')?.textContent.includes('钱包已连接'));
  for(const language of ['en','zh-TW','ja','ko','ru','es','zh']){
    await page.evaluate(language=>I18n.set(language),language);
    const text=await page.$eval('.btn-activate',e=>e.textContent);
    if(['en','ko','ru','es'].includes(language))assert(!/[\u4e00-\u9fff]/.test(text));
  }
  assert.equal(await page.$eval('.btn-activate',e=>e.textContent),'钱包已连接 · 确认身份后激活');

  // A signature for the old account must not be submitted after switching wallets.
  const previousSubmissions=loginSubmissions;
  await page.evaluate(()=>{
    testHoldSign=true;
    window.testLoginRequest=ensurePlatformSession(null,{force:true}).catch(error=>{window.testLoginError=error.message;});
  });
  await page.waitForFunction(()=>!!window.testFinishSign);
  await page.evaluate(address=>{
    renderWalletConnection({address,provider:testProvider});
    testFinishSign('STALE_SIGNATURE');
  },addressA);
  await page.evaluate(()=>window.testLoginRequest);
  assert.equal(loginSubmissions,previousSubmissions);
  assert.equal(await page.evaluate(()=>currentWalletProfile),null);
  assert.match(await page.evaluate(()=>testLoginError),/钱包账户已切换/);
  assert.match(await page.$eval('#wallet-connect-btn',e=>e.textContent),/^0x1271/);
  assert(!await page.evaluate(()=>testRequests.includes('eth_sendTransaction')));
  assert.deepEqual(errors,[]);
  // A current-session 401 must still revoke authentication, so real expiry is not hidden.
  await page.evaluate(address=>renderWalletProfile({authenticated:true,address,balances:{USDT:'0'}}),addressA);
  await page.evaluate(()=>handlePlatformUnauthorized({status:401},getWalletStateRevision()));
  assert.equal(await page.evaluate(()=>!!currentWalletProfile?.authenticated),false);
  assert.match(await page.$eval('.btn-activate',e=>e.textContent),/钱包已连接/);
  console.log('PASS: restored address, cancelled signature, manual retry, immediate login UI during slow requests, stale wallet/trading 401, current-session expiry, disconnect race, account switch during signing and 7 languages');
} finally { await browser.close(); }
