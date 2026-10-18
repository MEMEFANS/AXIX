import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import puppeteer from 'puppeteer';
import { createWalletService } from '../src/wallet-service.js';
import { createSupportService } from '../src/support-service.js';
import { closeDatabase } from '../src/database.js';

const app = path.resolve(import.meta.dirname,'..');
const artifact = path.resolve(app,'../../tools/funds-permissions-20261011');
fs.mkdirSync(artifact,{ recursive:true });
const root = fs.mkdtempSync(path.join(os.tmpdir(),'wg-admin-browser-'));
const wallet = '0x' + '8'.repeat(40);
const credential = 'TEST_ONLY_FUNDS_BROWSER_CREDENTIAL';
const attack = '<img src=x onerror="window.auditPwned=1"><svg onload="window.auditPwned=2"></svg><script>window.auditPwned=3</script>';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZCZsAAAAASUVORK5CYII=';
const result = { scenarios:[], isolatedDatabase:true, runtimeErrors:[] };
const mark = text => { result.scenarios.push(text); console.log('PASS: ' + text); };
let child, browser;
try {
  const service = createWalletService({ dataRoot:root, depositAddress:'0x' + 'd'.repeat(40), networks:[] });
  service.ensureUser(wallet);
  const support = createSupportService({ database:service.database });
  const session = support.userPost(wallet, attack + '\n普通咨询');
  support.adminReply(session.ticket.id, attack + '\n客服回复');
  for (const [id,screenshotUrl] of [['bad',attack],['good',png]]) service.database.insertSocialSubmission({ id:'ss_' + id, wallet, platform:'twitter', screenshotUrl, status:'pending', reviewer:'', reviewedAt:null, pointsAwarded:0, createdAt:Date.now() });
  closeDatabase(root);
  const env = Object.fromEntries(['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','APPDATA','LOCALAPPDATA','USERPROFILE','COMSPEC'].filter(name => process.env[name]).map(name => [name,process.env[name]]));
  Object.assign(env, { WG_DATA_DIR:root, PORT:'0', HOST:'127.0.0.1', DE_MODE:'paper', EX_MODE:'paper', RS_MODE:'paper', PLATFORM_ADMIN_USERNAME:'audit-operator', PLATFORM_ADMIN_PASSWORD:'TEST_ONLY_OPERATOR_PASSWORD', WALLET_ADMIN_TOKEN:credential });
  child = spawn(process.execPath,['src/server.js'],{ cwd:app, env, stdio:['ignore','pipe','pipe'], windowsHide:true });
  let log = '';
  const base = await new Promise((resolve,reject) => {
    const deadline = setTimeout(() => reject(new Error('Isolated server startup timed out')),25000);
    child.stdout.on('data',data => { log += data.toString(); const match = log.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(deadline); resolve(match[0]); } });
    child.stderr.on('data',data => { log += data.toString(); });
    child.once('exit',code => { clearTimeout(deadline); reject(new Error('Isolated server exited: ' + code + '; ' + log.slice(-700))); });
  });
  result.testServer = base;
  browser = await puppeteer.launch({ executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
  const admin = await browser.newPage();
  admin.on('pageerror',error => result.runtimeErrors.push(error.message));
  const adminResponse = await admin.goto(base + '/admin.html',{ waitUntil:'domcontentloaded' });
  assert(!adminResponse.headers()['content-security-policy'].match(/script-src[^;]*unsafe-inline/));
  assert.equal(adminResponse.headers()['cache-control'],'no-store');
  await admin.type('#admin-username','audit-operator'); await admin.type('#admin-password','TEST_ONLY_OPERATOR_PASSWORD'); await admin.click('#admin-login-button');
  await admin.waitForFunction(() => !document.getElementById('admin-app').hidden && document.getElementById('admin-updated').textContent.startsWith('更新于'));
  assert.equal(await admin.$('[data-admin-page="withdrawals"]'),null); assert.equal(await admin.$('[data-admin-page="test-credits"]'),null);
  assert.equal(await admin.$('#admin-aix-credit-form'),null);
  for (const [uri,method] of [['/api/admin/test-credits','POST'],['/api/admin/withdrawals/one','POST'],['/api/admin/withdrawal-automation','PATCH'],...['grant','debit','grant-miner','grant-stake','activations/confirm'].map(route => ['/api/admin/a-token/'+route,'POST'])]) {
    const checked = await admin.evaluate(async ({uri,method}) => { const response = await fetch(uri,{ method,headers:{'Content-Type':'application/json'},body:'{}' }); return { status:response.status, payload:await response.json() }; },{uri,method});
    assert.equal(checked.status,403); assert.equal(checked.payload.code,'FUNDS_ADMIN_REQUIRED');
  }
  assert.equal(await admin.evaluate(async () => (await fetch('/api/wallet/admin/test-credits')).status),401);
  for (const uri of ['/api/wallet/admin/asset-adjustments','/api/wallet/admin/miner-grants']) {
    assert.equal(await admin.evaluate(async uri => (await fetch(uri,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,uri),401);
  }
  await admin.click('[data-admin-page="a-miner"]'); await admin.waitForSelector('#am-open-funds');
  assert.equal(await admin.$('#am-grant'),null);
  const legacy = await fetch(base + '/withdraw-admin.html',{ redirect:'manual' }); assert.equal(legacy.status,302); assert.equal(legacy.headers.get('location'),'/funds-admin.html');
  const encoded = await fetch(base + '/%61dmin.html'); assert(!encoded.headers.get('content-security-policy').match(/script-src[^;]*unsafe-inline/));
  mark('actual server blocks operator funding/review endpoints, denies cookie access to funds API and redirects legacy console');

  await admin.click('[data-admin-page="support"]'); await admin.waitForSelector('[data-support-ticket]'); await admin.click('[data-support-ticket]');
  await admin.waitForFunction(() => document.querySelectorAll('#admin-support-messages .as-bubble').length === 2);
  assert.deepEqual(await admin.$$eval('#admin-support-messages .as-bubble',nodes => nodes.map(node => node.textContent)),[attack + '\n普通咨询',attack + '\n客服回复']);
  assert.equal(await admin.$('#admin-support-messages img, #admin-support-messages svg, #admin-support-messages script'),null);
  assert.equal(await admin.evaluate(() => window.auditPwned),undefined);
  await admin.screenshot({path:path.join(artifact,'support-safe.png'),fullPage:true});
  mark('stored malicious support messages render only as text in ticket preview and conversation');
  await admin.evaluate(attack => { window.testPrompt = promptDialog(attack,attack + '"'); },attack);
  await admin.waitForSelector('.aim-confirm-dialog'); assert.equal(await admin.$('.aim-confirm-dialog img'),null);
  assert.equal(await admin.$eval('.aim-prompt-input',node => node.value),attack + '"'); await admin.click('.aim-confirm-cancel');
  await admin.evaluate(() => { const script = document.createElement('script'); script.textContent = 'window.auditInlineExecuted=1'; document.body.append(script); const image = document.createElement('img'); image.setAttribute('onerror','window.auditEventExecuted=1'); image.src='/nonexistent-test-image'; document.body.append(image); });
  await admin.waitForFunction(() => document.querySelector('img[src="/nonexistent-test-image"]')?.complete);
  assert.equal(await admin.evaluate(() => window.auditInlineExecuted),undefined); assert.equal(await admin.evaluate(() => window.auditEventExecuted),undefined);
  mark('text-safe dialogs and actual CSP prevent injected script tags and inline event handlers');

  await admin.click('[data-admin-page="lottery"]'); await admin.waitForSelector('[data-al-tab="social"]'); await admin.click('[data-al-tab="social"]');
  await admin.waitForSelector('[data-social-approve="ss_bad"]'); assert.equal(await admin.$eval('[data-social-approve="ss_bad"]',node => node.disabled),true);
  assert.equal(await admin.$('[data-shot="ss_bad"]'),null); assert.equal(await admin.$eval('[data-social-approve="ss_good"]',node => node.disabled),false);
  await admin.click('[data-shot="ss_good"]'); await admin.waitForSelector('dialog iframe');
  assert.equal(await admin.$eval('dialog iframe',node => node.getAttribute('sandbox')),'');
  const frame = await (await admin.$('dialog iframe')).contentFrame();
  await frame.waitForSelector('img');
  await frame.waitForFunction(() => document.querySelector('img')?.naturalWidth > 0);
  assert.equal(await frame.evaluate(() => { try { return Boolean(parent.document); } catch { return false; } }),false);
  await admin.click('dialog button');
  mark('invalid legacy images cannot be approved; valid screenshot opens in a scriptless frame with no parent access');

  const user = await browser.newPage(); user.on('pageerror',error => result.runtimeErrors.push(error.message));
  await user.setRequestInterception(true);
  user.on('request',request => {
    const url = new URL(request.url());
    if (url.origin !== base) return request.abort();
    if (url.pathname === '/api/support/session') return request.respond({ contentType:'application/json',body:JSON.stringify({ ticket:session.ticket,messages:[{sender:'user',body:attack + '\n普通咨询',createdAt:Date.now()},{sender:'admin',body:attack + '\n客服回复',createdAt:Date.now()}] }) });
    if (url.pathname.startsWith('/api/')) return request.respond({ contentType:'application/json',body:JSON.stringify(url.pathname === '/api/wallet/session' ? {authenticated:false} : url.pathname === '/api/a-token/plans' ? {activation:[],staking:[]} : {}) });
    return request.continue();
  });
  await user.goto(base + '/', {waitUntil:'domcontentloaded'});
  await user.waitForFunction(() => Boolean(window.Portal) && typeof switchTab === 'function');
  await user.evaluate(wallet => { window.currentWalletConnection={ address:wallet }; window.currentWalletProfile={ authenticated:true,address:wallet,balances:{} }; return switchTab('support'); },wallet);
  await user.waitForFunction(() => document.querySelectorAll('#support-messages .support-msg-bubble').length === 2);
  assert.equal(await user.$('#support-messages img, #support-messages svg, #support-messages script'),null);
  assert.equal(await user.$eval('#support-messages .support-msg-bubble',node => node.textContent),attack + '\n普通咨询');
  assert.equal(await user.evaluate(() => window.auditPwned),undefined);
  mark('customer chat also renders user/admin payloads as plain text and preserves newlines');

  const funds = await browser.newPage(); funds.on('pageerror',error => result.runtimeErrors.push(error.message));
  await funds.setBypassServiceWorker(true);
  await funds.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await funds.evaluateOnNewDocument(() => sessionStorage.setItem('wd_admin_token','TEST_ONLY_LEGACY_SECRET'));
  funds.on('dialog',dialog => dialog.accept(dialog.type() === 'prompt' ? '测试拒绝' : undefined));
  const mutations = []; let attempts = 0, heldWithdrawal = null, holdWithdrawal = false, hasHistory = false, adversarialRecord = true;
  const assetMutations = [], minerMutations = []; let assetAttempts = 0, minerAttempts = 0;
  await funds.setRequestInterception(true);
  funds.on('request',request => {
    const url = new URL(request.url());
    if (url.origin !== base) return request.abort();
    const respond = (data,status=200) => request.respond({status,contentType:'application/json',body:JSON.stringify(data)});
    if (url.pathname === '/api/wallet/admin/asset-adjustments') {
      if (request.method() === 'POST') {
        assetMutations.push(JSON.parse(request.postData()));
        if (++assetAttempts === 1) return respond({error:'资产调整网络失败'},503);
        return respond({ok:true,adjustment:{amount:'2.000000000000000001'}});
      }
      return respond({items:[{wallet,asset:'A',amount:'2.000000000000000001',type:'funds_grant',reason:attack,adminUsername:'funds-admin',createdAt:Date.now()}]});
    }
    if (url.pathname === '/api/wallet/admin/miner-grants') {
      if (request.method() === 'POST') {
        minerMutations.push(JSON.parse(request.postData()));
        if (++minerAttempts === 1) return respond({error:'矿机赠送网络失败'},503);
        return respond({ok:true,miner:{id:'test-miner'}});
      }
      return respond({items:minerAttempts > 1 ? [{wallet,plan:'mini120',miner:{id:'test-miner'},reason:attack,adminUsername:'funds-admin',createdAt:Date.now()}] : []});
    }
    if (url.pathname === '/api/wallet/admin/withdrawals' && request.method() === 'GET') {
      if (holdWithdrawal) { heldWithdrawal=request; return; }
      return respond({items:[{id:'test-id',wallet:adversarialRecord ? attack : wallet,networkName:adversarialRecord ? attack : 'BNB Smart Chain',asset:'USDT',amount:'1.2',status:'pending_review',createdAt:Date.now()}]});
    }
    if (url.pathname === '/api/wallet/admin/test-credits') {
      if (request.method() === 'POST') { mutations.push(JSON.parse(request.postData())); if (++attempts === 1) return respond({error:'测试网络失败，请重试'},503); hasHistory=true; return respond({ok:true,adjustment:{amount:'10'}}); }
      return respond({items:hasHistory ? [{wallet,amount:'10',reason:attack,adminUsername:'funds-admin',createdAt:Date.now()}] : []});
    }
    return request.continue();
  });
  const fundsResponse = await funds.goto(base + '/funds-admin.html',{waitUntil:'domcontentloaded'});
  assert(!fundsResponse.headers()['content-security-policy'].includes('unsafe-inline'));
  await funds.type('#funds-token',credential); await funds.click('#funds-login-form button');
  await funds.waitForFunction(() => !document.getElementById('funds-app').hidden && document.querySelector('#funds-withdrawals-body tr'));
  assert.equal(await funds.$('#funds-withdrawals-body img, #funds-withdrawals-body script, #funds-withdrawals-body svg'),null);
  assert.equal(await funds.$eval('#funds-token',node => node.value),'');
  assert.equal(await funds.evaluate(() => sessionStorage.getItem('wd_admin_token')),null);
  assert(!JSON.stringify(await funds.evaluate(() => ({local:{...localStorage},session:{...sessionStorage}}))).includes(credential));
  adversarialRecord = false;
  await funds.click('#funds-refresh');
  await funds.waitForFunction(() => document.querySelector('#funds-withdrawals-body .wallet')?.textContent === '0x' + '8'.repeat(40));
  await funds.screenshot({path:path.join(artifact,'funds-admin.png'),fullPage:true});
  await funds.click('#funds-tab-credits'); await funds.type('#funds-credit-wallet',wallet); await funds.type('#funds-credit-amount','10'); await funds.type('#funds-credit-reason','浏览器隔离测试'); await funds.click('#funds-credit-form button');
  await funds.waitForFunction(() => document.getElementById('funds-status').textContent.includes('测试网络失败'));
  await funds.click('#funds-credit-form button'); await funds.waitForFunction(() => document.getElementById('funds-status').textContent.includes('已入账'));
  assert.equal(mutations.length,2); assert.equal(mutations[0].requestId,mutations[1].requestId);
  await funds.waitForFunction(() => document.querySelector('#funds-credits-body tr td:nth-child(4)')?.textContent.includes('window.auditPwned'));
  assert.equal(await funds.$('#funds-credits-body img, #funds-credits-body script, #funds-credits-body svg'),null);
  mark('mobile funds console uses independent auth without storing the token; safe records and retry retain the same request ID');
  await funds.click('#funds-tab-assets');
  await funds.type('#funds-asset-wallet',wallet);await funds.type('#funds-asset-amount','2.000000000000000001');await funds.type('#funds-asset-reason','资产权限回归');
  await funds.click('#funds-asset-form button');await funds.waitForFunction(()=>document.getElementById('funds-status').textContent.includes('资产调整网络失败'));
  await funds.click('#funds-asset-form button');await funds.waitForFunction(()=>document.getElementById('funds-status').textContent.includes('已赠送'));
  assert.equal(assetMutations.length,2);assert.equal(assetMutations[0].requestId,assetMutations[1].requestId);
  assert.equal(assetMutations[1].amount,'2.000000000000000001');
  assert.equal(await funds.$('#funds-assets-body img, #funds-assets-body svg, #funds-assets-body script'),null);
  await funds.click('#funds-tab-miners');await funds.type('#funds-miner-wallet',wallet);await funds.type('#funds-miner-reason','矿机权限回归');
  await funds.click('#funds-miner-form button');await funds.waitForFunction(()=>document.getElementById('funds-status').textContent.includes('矿机赠送网络失败'));
  await funds.click('#funds-miner-form button');await funds.waitForFunction(()=>document.getElementById('funds-status').textContent.includes('矿机已赠送'));
  assert.equal(minerMutations.length,2);assert.equal(minerMutations[0].requestId,minerMutations[1].requestId);
  await funds.waitForSelector('#funds-miners-body td.wallet');
  assert.equal(await funds.$('#funds-miners-body img, #funds-miners-body svg, #funds-miners-body script'),null);
  mark('funds-only asset/miner forms work on mobile, keep full AIX precision and retry with one request ID');
  await funds.click('#funds-tab-withdrawals'); await funds.waitForFunction(() => document.getElementById('funds-withdrawal-count').textContent.includes('1 条'));
  holdWithdrawal=true; await funds.click('#funds-refresh'); await funds.waitForFunction(() => document.getElementById('funds-app').hidden === false);
  const deadline = Date.now()+3000; while (!heldWithdrawal && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25)); assert(heldWithdrawal);
  await funds.click('#funds-lock'); await heldWithdrawal.respond({contentType:'application/json',body:JSON.stringify({items:[{id:'stale',wallet,amount:'999'}]})});
  await funds.waitForFunction(() => document.getElementById('funds-status').textContent.includes('锁定'));
  assert.equal(await funds.$eval('#funds-app',node=>node.hidden),true); assert.equal(await funds.$eval('#funds-withdrawals-body',node=>node.childElementCount),0);
  assert.equal(await funds.$eval('#funds-assets-body',node=>node.childElementCount),0);assert.equal(await funds.$eval('#funds-miners-body',node=>node.childElementCount),0);
  mark('locking clears sensitive data and rejects an old in-flight response');
  assert.deepEqual(result.runtimeErrors,[]);
  result.passed=true;
} catch (error) {
  result.passed=false; result.error=error.stack; process.exitCode=1;
  console.error(error);
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { const stopped = once(child,'exit'); child.kill('SIGTERM'); await Promise.race([stopped,new Promise(resolve=>setTimeout(resolve,4000))]); if (child.exitCode === null) child.kill('SIGKILL'); }
  closeDatabase(root);
  // Remove only the test directory we created under the system temporary directory.
  const absolute = fs.realpathSync(root); assert(absolute.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)); fs.rmSync(absolute,{recursive:true,force:true});
  result.checkedAtUtc=new Date().toISOString(); fs.writeFileSync(path.join(artifact,'browser-result.json'),JSON.stringify(result,null,2));
}
