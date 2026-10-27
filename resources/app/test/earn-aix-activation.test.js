import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer';
import { Wallet, parseUnits } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { closeDatabase } from '../src/database.js';
import { createATokenService } from '../src/a-token-service.js';
import { createATokenMinerService } from '../src/a-token-miner-service.js';
import { createATokenActivationService } from '../src/a-token-activation-service.js';
import { createATokenApi } from '../src/a-token-api.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'earn-aix-browser-'));
const publicDir = path.resolve(import.meta.dirname, '../public');
const user = Wallet.createRandom();
const ws = createWalletService({ dataRoot: root, networks: [] });
const db = ws.database;
ws.creditBalance(user.address, 'A', parseUnits('5000', 18));
const at = createATokenService({ database: db, walletService: ws });
const miners = createATokenMinerService({ database: db, aTokenService: at });
const activation = createATokenActivationService({ database: db, aTokenService: at, minerService: miners });
let loseNextResponse = false, oldPlanMode = false, holdSign = false, rejectStatus = false;
let releaseSign;
const api = createATokenApi({ aTokenService: at, activationService: activation, minerService: miners, walletService: ws,
  poolService: { stats: () => at.poolStats() }, stakingService: { STAKE_PLANS: {}, present: () => [] },
  teamService: { summary: () => ({ directCount: 0, teamCount: 0 }) },
  getSession: () => ({ address: user.address }),
  readBody: async req => { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body || '{}'); },
  send: (res, status, data) => {
    if (loseNextResponse && data.activation?.record?.paymentAsset === 'AIX') {
      loseNextResponse = false;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '10000' });
      res.write('{'); setTimeout(() => res.destroy(), 30); return true;
    }
    if (oldPlanMode && data.paymentMode) delete data.paymentMode;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data)); return true;
  },
});
const fixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/styles/critical.css"><link rel="stylesheet" href="/styles/lazy.css">
<style>#tab-earn:not(.active),#tab-a-token-trade:not(.active){display:none}</style>
<body><div id="tab-earn" class="active"></div><div id="tab-a-token-trade"></div><script>
var currentWalletConnection={address:${JSON.stringify(user.address)}},currentWalletProfile={authenticated:true};
var connectedWalletAddress=currentWalletConnection.address;
var connectedProvider={request:async function(r){window.walletMethods.push(r.method);if(r.method!=='personal_sign')throw Error('Unexpected chain payment');if(window.cancelSign){window.cancelSign=false;throw {code:4001,message:'User rejected'};}return window.signActivation(r.params[0]);}};
window.walletMethods=[];window.toasts=[];window.showToast=(message)=>window.toasts.push(message);
window.confirmDialog=async message=>{window.lastConfirm=message;return true;};
</script><script src="/js/portal-shared.js"></script><script src="/js/earn.js"></script><script src="/js/a-token-trade.js"></script>
<script>Portal.load('earn');</script></body></html>`;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local.test');
    if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fixture); return; }
    if (url.pathname === '/api/a-token/activation-request' && rejectStatus) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"请重新确认钱包"}'); return;
    }
    if (url.pathname.startsWith('/api/a-token/')) { await api.handle(req, res, url.pathname); return; }
    const file = path.resolve(publicDir, '.' + url.pathname);
    if (file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const types = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
      res.end(fs.readFileSync(file)); return;
    }
    res.writeHead(404); res.end('{}');
  } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const screenshotDir = process.env.AIX_ACTIVATION_SCREENSHOTS;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('signActivation', async message => {
    if (holdSign) await new Promise(resolve => { releaseSign = resolve; });
    return user.signMessage(message);
  });
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  await page.goto(origin, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.act-card.pro .btn-activate');
  assert.match(await page.$eval('.act-card.mini', el => el.innerText), /20\s*AIX/);
  assert.match(await page.$eval('.act-card.pro', el => el.innerText), /400\s*AIX/);
  assert.doesNotMatch(await page.$eval('#earn-content', el => el.innerText), /BNB|激活名额进度|满额后/);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile activation page must fit the viewport');
  if (screenshotDir) { fs.mkdirSync(screenshotDir, { recursive: true }); await page.screenshot({ path: path.join(screenshotDir, 'activation-mobile.png'), fullPage: true }); }
  await page.evaluate(async () => { window.cancelSign = true; await earnActivate('1'); });
  assert.equal(at.totalBurned(), 0n, 'Cancelled signature cannot charge');
  assert.equal(db.listATokenMiners(user.address).length, 0);
  await page.evaluate(() => earnActivate('1'));
  assert.equal(at.totalBurned(), parseUnits('20', 18));
  assert.match(await page.$eval('.act-card.mini .btn-activate', el => el.innerText), /已激活/);
  await page.evaluate(() => Promise.all([earnActivate('2'), earnActivate('2')]));
  assert.equal(db.listATokenMiners(user.address).filter(m => m.plan === 'pro1500').length, 1, 'Double click creates one purchase');
  await page.evaluate(() => earnActivate('2'));
  assert.equal(db.listATokenMiners(user.address).filter(m => m.plan === 'pro1500').length, 2, 'Pro can activate again');
  assert.equal(at.totalBurned(), parseUnits('820', 18));
  assert.match(await page.$eval('.act-card.pro .btn-activate', el => el.innerText), /立即激活/);
  assert.equal(await page.$$eval('.portal-table tbody tr', nodes => nodes.filter(n => n.innerText.includes('已全额销毁')).length), 3);

  loseNextResponse = true;
  await page.evaluate(() => earnActivate('2'));
  assert.equal(at.totalBurned(), parseUnits('1220', 18));
  assert(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('axix_activation_aix_request_v1:'))));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !Object.keys(localStorage).some(key => key.startsWith('axix_activation_aix_request_v1:')));
  assert.equal(at.totalBurned(), parseUnits('1220', 18), 'Reload recovers the committed purchase without another charge');
  assert.equal(db.listATokenMiners(user.address).length, 4);
  // A failed status lookup must preserve the unresolved ID across session renewal.
  await page.evaluate(address => {
    localStorage.setItem('axix_activation_aix_request_v1:' + address.toLowerCase(), JSON.stringify({ wallet: address.toLowerCase(), plan: '2', requestId: 'activation_expired_resume_request', timestamp: '1000000000000', signature: 'expired' }));
  }, user.address);
  rejectStatus = true;
  await page.reload({ waitUntil: 'networkidle0' });
  assert(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('axix_activation_aix_request_v1:'))));
  rejectStatus = false;
  await page.evaluate(() => earnActivate('2'));
  assert(activation.getRequest(user.address, '2', 'activation_expired_resume_request'), 'Expired request is re-signed under its original ID');
  assert.equal(at.totalBurned(), parseUnits('1620', 18));
  oldPlanMode = true;
  await page.evaluate(() => earnActivate('2'));
  assert.equal(at.totalBurned(), parseUnits('1620', 18), 'Old server plan config must fail before signature/payment');
  oldPlanMode = false;
  holdSign = true;
  const switching = page.evaluate(() => earnActivate('2'));
  while (!releaseSign) await new Promise(resolve => setTimeout(resolve, 10));
  await page.evaluate(() => { currentWalletConnection.address = '0x' + '1'.repeat(40); });
  releaseSign(); holdSign = false;
  await switching;
  assert.equal(at.totalBurned(), parseUnits('1620', 18), 'Wallet switch while signing cannot charge');
  await page.evaluate(address => { currentWalletConnection.address = address; }, user.address);
  assert.deepEqual(await page.evaluate(() => [...new Set(walletMethods)]), ['personal_sign'], 'Activation never sends a chain transaction');
  await page.setViewport({ width: 1440, height: 1000 });
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, 'activation-desktop.png'), fullPage: true });

  // Trading hall receives activation burns on entry and while already open.
  await page.evaluate(async () => {
    document.getElementById('tab-earn').classList.remove('active');
    document.getElementById('tab-a-token-trade').classList.add('active');
    await Portal.load('a-token-trade');
  });
  await page.waitForFunction(() => document.getElementById('atrade-burn-total')?.textContent.includes('1,620'));
  activation.activate(user.address, '2', 'activation_browser_external_request');
  await page.waitForFunction(() => document.getElementById('atrade-burn-total')?.textContent.includes('2,020'), { timeout: 12000 });
  assert.match(await page.$eval('#atrade-burn-today', el => el.innerText), /2,020/);
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, 'trade-live-burn.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS real-browser mobile/desktop, wallet signature cancellation, repeat Pro, double-click, lost-response/reload recovery, wallet switch, stale mode, live trading burn polling');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  closeDatabase(root);
  fs.rmSync(root, { recursive: true, force: true });
}
