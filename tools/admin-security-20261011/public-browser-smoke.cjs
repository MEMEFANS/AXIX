const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const app = path.resolve(__dirname,'../../resources/app');
const puppeteer = createRequire(path.join(app,'package.json'))('puppeteer');
const login = JSON.parse(fs.readFileSync(path.join(__dirname,'login-private.json'),'utf8'));
const result = {passed:false,production:true,financialMutationsPerformed:false,checks:[],runtimeErrors:[],blockedUnexpectedWrites:[],apiResponses:[]};
let browser, admin;
async function page() {
  const item = await browser.newPage();
  item.on('pageerror',error=>result.runtimeErrors.push(error.message));
  item.on('response',response=>{const uri=new URL(response.url());if(uri.pathname.startsWith('/api/admin/'))result.apiResponses.push({path:uri.pathname,status:response.status()});});
  await item.setRequestInterception(true);
  item.on('request',request=>{
    const uri = new URL(request.url());
    if(uri.pathname==='/cdn-cgi/rum')return request.abort();
    if(!['GET','HEAD','OPTIONS'].includes(request.method()) && !['/api/admin/login','/api/admin/logout'].includes(uri.pathname)) {
      result.blockedUnexpectedWrites.push({path:uri.pathname,method:request.method()});return request.abort();
    }
    return request.continue();
  });
  return item;
}
(async()=>{
 try {
  browser = await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const funds = await page();
  await funds.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await funds.goto('https://axix.cc/funds-admin.html',{waitUntil:'domcontentloaded',timeout:40000});
  await funds.type('#funds-token',login.fundsToken);
  await funds.click('#funds-login-form button');
  await funds.waitForFunction(()=>!document.getElementById('funds-app').hidden && document.getElementById('funds-auto-state').textContent==='自动提现已关闭', {timeout:25000});
  await funds.waitForFunction(()=>document.getElementById('funds-withdrawals-body').children.length>0,{timeout:25000});
  assert.equal(await funds.$eval('#funds-token',node=>node.value),'');
  assert.equal(await funds.evaluate(()=>sessionStorage.getItem('wd_admin_token')),null);
  result.checks.push('mobile funds console accepts existing token, loads withdrawals and keeps automatic payout disabled');
  await funds.click('#funds-tab-credits');
  await funds.waitForFunction(()=>document.getElementById('funds-credits-body').children.length>0,{timeout:25000});
  assert.equal(await funds.$('[data-social-approve]'),null);
  result.checks.push('test-credit history loads in the same independent funds console');
  await funds.click('#funds-lock');
  assert.equal(await funds.$eval('#funds-app',node=>node.hidden),true);
  assert.equal(await funds.$eval('#funds-credits-body',node=>node.children.length),0);
  result.checks.push('locking clears funds data and credential');
  admin = await page();
  await admin.goto('https://axix.cc/admin.html',{waitUntil:'domcontentloaded',timeout:40000});
  await admin.type('#admin-username',login.username);await admin.type('#admin-password',login.password);await admin.click('#admin-login-button');
  await admin.waitForFunction(()=>!document.getElementById('admin-app').hidden && document.getElementById('admin-updated').textContent.startsWith('更新于'),{timeout:30000});
  assert.equal(await admin.$('[data-admin-page="withdrawals"]'),null);
  assert.equal(await admin.$('[data-admin-page="test-credits"]'),null);
  result.checks.push('operator login works and funding panels are removed');
  await admin.click('[data-admin-page="lottery"]');
  await admin.waitForSelector('[data-al-tab="social"]',{timeout:20000});await admin.click('[data-al-tab="social"]');
  await admin.waitForFunction(()=>Boolean(document.querySelector('#al-content .al-table') || document.querySelector('#al-content .al-empty')),{timeout:25000});
  const checks = await admin.evaluate(async()=>{
    const response=await fetch('/api/admin/lottery/social');const {list}=await response.json();
    const ids=['ss_3ca9f7559510856c8311','ss_f0178e4ea0f6a05e8e26'];
    const known=list.filter(item=>ids.includes(item.id));
    return {status:response.status,known:known.length,suppressed:known.every(item=>item.screenshotSafe===false && !item.screenshotUrl),unsafeNodes:ids.some(id=>document.querySelector(`[data-shot="${id}"]`))};
  });
  assert.equal(checks.status,200);assert.equal(checks.known,2);assert.equal(checks.suppressed,true);assert.equal(checks.unsafeNodes,false);
  result.checks.push('historical script images are suppressed through the live operator list and have no preview control');
  await admin.click('[data-admin-page="support"]');
  await admin.waitForFunction(()=>Boolean(document.querySelector('[data-support-ticket]') || document.getElementById('admin-support-ticket-list')?.textContent.includes('暂无')),{timeout:25000});
  const ticket = await admin.$('[data-support-ticket]');
  if(ticket){await ticket.click();await admin.waitForFunction(()=>document.querySelectorAll('#admin-support-messages .as-bubble').length>0,{timeout:20000});assert.equal(await admin.$('#admin-support-messages .as-bubble script, #admin-support-messages .as-bubble img'),null);}
  result.checks.push('operator customer-service conversation renders after strict CSP is enabled');
  await admin.evaluate(async()=>{const response=await fetch('/api/admin/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw Error('logout failed');});
  assert.deepEqual(result.blockedUnexpectedWrites,[]);assert.deepEqual(result.runtimeErrors,[]);
  result.passed=true;
 } catch(error) {
  result.error=error.message;process.exitCode=1;
  if(admin)result.operatorUi=await admin.evaluate(()=>({appHidden:document.getElementById('admin-app')?.hidden,updated:document.getElementById('admin-updated')?.textContent,loginStatus:document.getElementById('admin-login-error')?.textContent,toasts:[...document.querySelectorAll('.admin-toast')].map(node=>node.textContent)})).catch(()=>({}));
 }
 finally {
  if(browser)await browser.close();
  fs.writeFileSync(path.join(__dirname,'public-browser-result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
 }
})();
