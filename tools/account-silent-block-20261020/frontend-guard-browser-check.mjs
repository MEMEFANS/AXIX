import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectCDP } from '../run-aix/cdp.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const guard = await fs.readFile(path.join(root, 'candidate/public/js/account-action-guard.js'));
const calls = [];
const checks = [];
const results = { fixtureOnly: true, productionContacted: false, checks, requests: calls };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const start = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
const external = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'X-AxiX-Action', 'X-AxiX-Action': 'idle'
  });
  res.end('external-fixture');
});
const externalPort = await start(external);
const fixture = http.createServer((req, res) => {
  calls.push({ method: req.method, path: req.url });
  if (req.url === '/guard.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
    return res.end(guard);
  }
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><script src="/guard.js"></script></head>
      <body><b id="balance">Fixture balance: 1,234</b><button id="action">Fixture action</button>
      <form id="form"><input id="typing"><button type="submit">Submit</button></form><script>
      window.state={actions:0,submits:0,keys:0,pointers:0,marker:'pending',slow:'pending',slowError:'pending',later:0};
      action.addEventListener('click',()=>state.actions++);
      form.addEventListener('submit',e=>{e.preventDefault();state.submits++});
      document.addEventListener('keydown',e=>{if(e.key==='x')state.keys++});
      document.addEventListener('pointerdown',()=>state.pointers++);
      window.externalFixture='http://127.0.0.1:${externalPort}/api/external';
      </script></body></html>`);
  }
  if (req.url === '/api/normal') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true,"fixture":true}');
  }
  if (req.url === '/api/error') {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end('{"error":"fixture ordinary failure"}');
  }
  if (req.url === '/api/network-error') return req.socket.destroy();
  if (req.url === '/api/slow') {
    return setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    }, 400);
  }
  if (req.url === '/api/slow-error') return setTimeout(() => req.socket.destroy(), 400);
  if (req.url === '/api/mark') {
    res.writeHead(204, { 'X-AxiX-Action': 'idle', 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (req.url === '/fixture-static') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'X-AxiX-Action': 'idle' });
    return res.end('static-fixture');
  }
  res.writeHead(404); res.end('fixture route not found');
});
const fixturePort = await start(fixture);
results.fixtureUrl = `http://127.0.0.1:${fixturePort}/`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'axix-account-guard-fixture-'));
results.temporaryProfile = profile;
const chromePath = process.env.AXIX_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank'
], { windowsHide: true, stdio: 'ignore' });
let launchError;
chrome.on('error', error => { launchError = error; });
let browser;
let failure;
try {
  let cdpPort;
  for (let i = 0; i < 160; i++) {
    if (launchError) throw launchError;
    try {
      cdpPort = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      if (cdpPort) break;
    } catch (_) {}
    await pause(50);
  }
  assert(cdpPort, 'isolated Chrome did not start');
  results.cdpPort = cdpPort;
  browser = await connectCDP(cdpPort);
  const call = browser.call;
  const evaluate = async expression => {
    const value = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
    return value.result.value;
  };
  await call('Runtime.enable'); await call('Page.enable');
  await call('Page.navigate', { url: results.fixtureUrl });
  for (let i = 0; i < 120 && !(await evaluate('!!window.state')); i++) await pause(25);
  assert(await evaluate('!!window.state'), 'fixture did not load');

  const normal = await evaluate(`(async()=>{const r=await fetch('/api/normal');return {status:r.status,body:await r.json()}})()`);
  assert.deepEqual(normal, { status: 200, body: { ok: true, fixture: true } });
  const ordinaryError = await evaluate(`(async()=>{const r=await fetch('/api/error');return {status:r.status,body:await r.json()}})()`);
  assert.equal(ordinaryError.status, 503);
  assert.equal(ordinaryError.body.error, 'fixture ordinary failure');
  assert.equal(await evaluate(`fetch('/api/network-error').then(()=>false,()=>true)`), true);
  checks.push('真实 Chrome：正常 JSON、503 响应和普通网络拒绝保持原始行为');

  const boundary = await evaluate(`Promise.all([fetch('/fixture-static').then(r=>r.text()),fetch(externalFixture).then(r=>r.text())])`);
  assert.deepEqual(boundary, ['static-fixture', 'external-fixture']);
  assert.equal(await evaluate(`fetch('/api/normal').then(r=>r.status)`), 200);
  checks.push('静态资源与跨源 fixture 的 idle 标记不触发冻结');

  const point = await evaluate(`(()=>{const r=action.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const realClick = async () => {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const realKey = async () => {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'x', code: 'KeyX', text: 'x', windowsVirtualKeyCode: 88 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 });
  };
  await realClick();
  await evaluate(`form.requestSubmit();typing.focus()`);
  await realKey();
  const before = await evaluate(`({...state,text:typing.value,balance:balance.textContent})`);
  assert.equal(before.actions, 1); assert.equal(before.submits, 1);
  assert.equal(before.keys, 1); assert.equal(before.pointers, 1); assert.equal(before.text, 'x');
  checks.push('普通用户的真实鼠标、键盘输入和表单业务 handler 正常执行');

  await evaluate(`fetch('/api/slow').then(()=>state.slow='resolved',()=>state.slow='rejected');fetch('/api/slow-error').then(()=>state.slowError='resolved',()=>state.slowError='rejected');fetch('/api/mark').then(()=>state.marker='resolved',()=>state.marker='rejected');true`);
  for (let i = 0; i < 100 && !calls.some(item => item.path === '/api/mark'); i++) await pause(10);
  await pause(100);
  assert(calls.some(item => item.path === '/api/mark'));
  const apiCount = calls.filter(item => item.path.startsWith('/api/')).length;
  await evaluate(`for(let i=0;i<25;i++)fetch('/api/never-sent',{method:'POST'}).then(()=>state.later++,()=>state.later++);true`);
  await realClick();
  await evaluate(`action.click();form.requestSubmit();typing.focus()`);
  await realKey();
  const dialogReturns = await evaluate(`({alert:typeof alert('fixture must be silent'),confirm:confirm('fixture must be silent'),prompt:prompt('fixture must be silent')})`);
  assert.deepEqual(dialogReturns, { alert: 'undefined', confirm: false, prompt: null });
  await pause(650);
  const after = await evaluate(`({...state,text:typing.value,balance:balance.textContent})`);
  assert.deepEqual(after, before);
  assert.equal(calls.filter(item => item.path.startsWith('/api/')).length, apiCount);
  assert.equal(calls.filter(item => item.path === '/api/never-sent').length, 0);
  assert.equal(browser.events.filter(event => event.method === 'Page.javascriptDialogOpening').length, 0);
  assert.equal(browser.events.filter(event => event.method === 'Runtime.exceptionThrown').length, 0);
  results.before = before; results.after = after;
  checks.push('命中 marker 后请求及两条在途请求保持 pending，25 次后续 API 均未发往服务器');
  checks.push('命中后真实点击、键盘、合成点击和表单均无业务执行，无原生弹窗、无运行异常，余额文字保留');
  assert.deepEqual(await evaluate(`Promise.all([fetch('/fixture-static').then(r=>r.text()),fetch(externalFixture).then(r=>r.text())])`), ['static-fixture', 'external-fixture']);
  checks.push('受限状态下静态资源与跨源请求继续保持正常');
  results.passed = true;
} catch (error) {
  results.passed = false;
  results.error = error.stack || String(error);
  failure = error;
} finally {
  if (browser) {
    // Closing this browser is safe: it was launched with this script's unique profile.
    browser.call('Browser.close').catch(() => {});
    await pause(500);
    browser.close();
  }
  if (chrome.exitCode === null) chrome.kill();
  await Promise.all([close(fixture), close(external)]);
  results.browserClosed = chrome.exitCode !== null;
  if (!results.browserClosed) {
    await pause(200);
    results.browserClosed = chrome.exitCode !== null;
  }
  results.serversClosed = !fixture.listening && !external.listening;
  results.profileRetained = true;
  results.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'frontend-guard-browser-results.json'), JSON.stringify(results, null, 2) + '\n');
}
if (failure) throw failure;
for (const check of checks) console.log('PASS ' + check);
console.log(JSON.stringify({ browserClosed: results.browserClosed, serversClosed: results.serversClosed }));
