// Product QA in the dedicated Chrome profile on port 9233. Synthetic local
// rounds only; preserve the pre-test stores and the unrelated runner profile.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { connectCDP } from '../run-aix/cdp.mjs';

const origin = 'http://127.0.0.1:4173', key = 'hash-aix:local:v1', settingsKey = 'hash-aix:settings:v1', lobbyKey = 'aix-play:lobby:v1', runnerKey = 'run-aix:player-profile:v1';
const out = new URL(process.env.HASH_QA_REPORT_DIR || './qa-v2/', import.meta.url), downloads = new URL(`downloads-${Date.now()}/`, out);
await mkdir(out, { recursive: true }); await mkdir(downloads, { recursive: true });
const c = await connectCDP(Number(process.env.HASH_QA_PORT || 9233));
const report = { fixture: 'isolated-local-qa', startedAt: new Date().toISOString(), checks: [], errors: [], screenshots: [] };
let clockId, backup, gameEventsEnd = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(expression) { const r = await c.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
async function until(expression, timeout = 8000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await evaluate(expression)) return; await pause(50); } throw new Error(`Timeout: ${expression}`); }
async function click(selector) { assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), true, selector); await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function navigate(path, wait = '') { const url = path.startsWith('http') || path === 'about:blank' ? path : origin + path; await c.call('Page.navigate', { url }); await until(`location.href===${JSON.stringify(url)} && document.readyState==='complete'${wait ? ` && (${wait})` : ''}`); }
async function route(name, prefix = 'page') { await evaluate(`location.hash=${JSON.stringify(name)}`); await until(`!document.getElementById('${prefix}-${name}').hidden`); }
async function viewport(width, height, mobile = width < 600) { await c.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); await pause(100); }
async function fits(name) { const d = await evaluate(`({width:innerWidth,scroll:document.documentElement.scrollWidth})`); assert.ok(d.scroll <= d.width + 1, `${name}: ${JSON.stringify(d)}`); }
async function screenshot(name, fullPage = false) { await evaluate(`window.scrollTo({top:0,behavior:'instant'})`); await pause(120); const d = await evaluate(`({width:innerWidth,height:${fullPage ? 'Math.max(innerHeight,document.documentElement.scrollHeight)' : 'innerHeight'}})`); const shot = await c.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage, clip: { x: 0, y: 0, ...d, scale: 1 } }); const path = new URL(`${name}.png`, out); await writeFile(path, Buffer.from(shot.data, 'base64')); report.screenshots.push(fileURLToPath(path)); }
async function data() { return evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(key)}))`); }
async function moveTime(now) { await evaluate(`window.hashV2QaClock=${now};sessionStorage.setItem('hash-v2-qa-clock',String(${now}))`); await pause(380); }
function pass(name) { report.checks.push({ name, pass: true }); console.log('PASS', name); }

try {
  await c.call('Page.enable'); await c.call('Runtime.enable'); await c.call('Network.enable');
  await c.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: fileURLToPath(downloads) });
  await viewport(1440, 1000);
  await navigate('/games.html', `document.querySelectorAll('#game-grid .game-card').length===2`);
  backup = await evaluate(`Object.fromEntries(${JSON.stringify([key, settingsKey, lobbyKey, runnerKey])}.map(k=>[k,localStorage.getItem(k)]))`);
  await evaluate(`${JSON.stringify([key, settingsKey, lobbyKey])}.forEach(k=>localStorage.removeItem(k));sessionStorage.removeItem('hash-v2-qa-clock')`);
  clockId = (await c.call('Page.addScriptToEvaluateOnNewDocument', { source: `if(location.origin===${JSON.stringify(origin)}){window.hashV2QaClock=Number(sessionStorage.getItem('hash-v2-qa-clock'))||Date.now();Date.now=()=>window.hashV2QaClock;}` })).identifier;
  await navigate('/hash-aix.html', `document.getElementById('round-id').textContent==='#000001'`);
  let state = await data();
  assert.equal(state.pending.mode, 'quick'); assert.equal(state.pending.revealsAt, null); assert.equal(state.balanceCents, 100000); assert.equal(state.records.length, 0);
  assert.equal(await evaluate(`document.getElementById('confirm').disabled`), true);
  assert.equal(await evaluate(`document.getElementById('full-commitment').textContent`), state.pending.commitment);
  assert.equal(await evaluate(`document.body.innerText.includes(${JSON.stringify(state.pending.seed)})`), false);
  await moveTime(state.pending.createdAt + 60000); assert.equal((await data()).records.length, 0);
  pass('Fresh quick round publishes commitment, waits for input and creates no automatic results');
  await click('#inspect-commitment'); assert.equal(await evaluate(`document.getElementById('commitment-dialog').open`), true); await click('#close-commitment');
  await viewport(390, 844); await click('[data-choice="odd"]');
  assert.equal(await evaluate(`document.querySelectorAll('#hex-ribbon .chosen').length`), 8);
  assert.equal(await evaluate(`document.getElementById('confirm').disabled`), false);
  const primary = await evaluate(`(()=>{const a=document.getElementById('confirm').getBoundingClientRect(),n=document.querySelector('.mobile-nav').getBoundingClientRect();return {top:a.top,bottom:a.bottom,nav:n.top}})()`);
  assert.ok(primary.top >= 0 && primary.bottom <= primary.nav, JSON.stringify(primary));
  await screenshot('hash-mobile-selected'); pass('Phone first viewport shows eight selected digits and the complete confirmation button');
  await click('[data-stake="20"]'); await click('#confirm'); await until(`!document.getElementById('ticket').hidden`);
  state = await data(); const pending = state.pending;
  assert.equal(state.balanceCents, 98000); assert.equal(pending.status, 'locked'); assert.equal(pending.revealsAt - pending.closesAt, 1600);
  await click('#confirm'); assert.equal((await data()).balanceCents, 98000);
  await navigate('about:blank'); await navigate('/hash-aix.html', `document.getElementById('round-id').textContent==='#000001'`);
  assert.equal((await data()).pending.id, pending.id); assert.equal((await data()).balanceCents, 98000);
  await moveTime(pending.revealsAt - 1); assert.equal((await data()).records.length, 0);
  await moveTime(pending.revealsAt); await until(`!document.getElementById('round-summary').hidden`);
  state = await data(); assert.equal(state.records.length, 1); assert.equal(state.balanceCents, 98000 + state.records[0].payoutCents);
  assert.equal(await evaluate(`document.getElementById('summary-stake').textContent`), '20.00 星点');
  assert.equal(await evaluate(`document.getElementById('summary-digit').textContent`), state.records[0].hexDigit.toUpperCase());
  const nextAction = await evaluate(`({button:document.getElementById('next-round').getBoundingClientRect().bottom,nav:document.querySelector('.mobile-nav').getBoundingClientRect().top})`);
  assert.ok(nextAction.button <= nextAction.nav, JSON.stringify(nextAction));
  await screenshot('hash-mobile-result'); await pause(500); assert.equal((await data()).records.length, 1);
  pass('Confirmation, refresh and exact reveal preserve one stake and produce one complete settlement card');
  await click('#summary-verify'); await until(`!document.getElementById('page-verify').hidden`); await click('#verify-button'); await until(`document.getElementById('verification-result').textContent.includes('计算已复核')`);
  assert.equal(await evaluate(`document.getElementById('verification-result').classList.contains('failed')`), false);
  pass('Result proof recomputes the actual commitment, hash, digit and credit return');
  await route('rules');
  await evaluate(`document.getElementById('round-mode').value='timed';document.getElementById('round-mode').dispatchEvent(new Event('change'));document.getElementById('client-seed').value='AIX-v2-qa';document.getElementById('seed-form').requestSubmit()`);
  await until(`document.getElementById('seed-message').textContent.includes('已保存')`);
  assert.equal((await data()).pending.clientSeed, pending.clientSeed);
  await click('#reduced-motion'); assert.equal(await evaluate(`document.body.classList.contains('reduced-motion')`), true);
  await route('game'); await click('#next-round'); await until(`document.getElementById('round-id').textContent==='#000002'`);
  state = await data(); assert.equal(state.pending.mode, 'timed'); assert.equal(state.pending.clientSeed, 'AIX-v2-qa'); assert.equal(state.pending.revealsAt - state.pending.createdAt, 18000);
  await route('rules'); await evaluate(`document.getElementById('round-mode').value='quick';document.getElementById('round-mode').dispatchEvent(new Event('change'))`);
  assert.equal((await data()).pending.mode, 'timed'); await route('game'); await moveTime(state.pending.revealsAt);
  await until(`!document.getElementById('round-summary').hidden`); state = await data(); assert.equal(state.records[0].choice, null);
  pass('Mode and player seed apply to the next round; legacy timed schedule and reduced motion work');
  await click('#next-round'); await until(`document.getElementById('round-id').textContent==='#000003'`);
  const beforeObserve = (await data()).balanceCents; await click('#observe'); await until(`document.getElementById('phase-pill').textContent==='正在揭晓'`);
  state = await data(); await moveTime(state.pending.revealsAt); await until(`!document.getElementById('round-summary').hidden`);
  state = await data(); assert.equal(state.balanceCents, beforeObserve); assert.equal(state.records[0].choice, null); assert.equal(state.stats.observed, 2);
  pass('Observe opens a real quick round without consuming credits or recording a wager');
  await route('history'); assert.equal(await evaluate(`document.querySelectorAll('#history-list .history-row').length`), 3);
  await click('[data-filter="played"]'); assert.equal(await evaluate(`document.querySelectorAll('#history-list .history-row').length`), 1);
  await click('[data-filter="all"]'); await click('#export-records');
  let files = []; for (let i = 0; i < 30; i++) { files = (await readdir(downloads)).filter(f => f.endsWith('.json')); if (files.length) break; await pause(100); }
  assert.equal(files.length, 1); const exported = JSON.parse(await readFile(new URL(files[0], downloads), 'utf8')); assert.deepEqual(exported.records, state.records);
  pass('History filters real participated rounds and exports the same three records');
  for (const [width, height] of [[320, 740], [390, 844], [1440, 1000]]) {
    await viewport(width, height);
    for (const page of ['game', 'history', 'verify', 'rules']) { await route(page); await fits(`hash ${width} ${page}`); }
    pass(`Hash game, history, verification and guide fit ${width}px`);
  }
  await route('game'); await screenshot('hash-desktop-result');
  await click('.back-lobby'); await until(`location.pathname==='/games.html' && document.querySelectorAll('#game-grid .game-card').length===2`);
  await until(`document.getElementById('journey-stats').textContent.includes('1 局参与')`);
  assert.equal((await data()).revision, state.revision);
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(runnerKey)})`), backup[runnerKey]);
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(lobbyKey)}))?.visits?.length || 0`), 0);
  pass('Lobby reads actual game progress without creating rounds or changing either game save');
  await screenshot('lobby-desktop', true);
  await click('[data-category="quick"]'); assert.equal(await evaluate(`document.querySelectorAll('#game-grid .game-card').length`), 1);
  assert.equal(await evaluate(`document.querySelector('#game-grid .card-heading').textContent.includes('哈希')`), true);
  await evaluate(`document.getElementById('game-search').value='不存在的游戏';document.getElementById('game-search').dispatchEvent(new Event('input'))`);
  assert.equal(await evaluate(`document.getElementById('catalog-empty').hidden`), false); await click('#reset-search');
  assert.equal(await evaluate(`document.querySelectorAll('#game-grid .game-card').length`), 2);
  await evaluate(`document.getElementById('game-search').value='RUNNER';document.getElementById('game-search').dispatchEvent(new Event('input'))`);
  assert.equal(await evaluate(`document.querySelectorAll('#game-grid .game-card').length`), 1); await click('#clear-search');
  pass('Lobby category, Chinese and English search, clear and empty-state reset work');
  await click('#game-grid [data-favorite="hash"]'); await route('library', 'view');
  assert.equal(await evaluate(`document.querySelectorAll('#favorite-grid .game-card').length`), 1);
  await navigate('about:blank'); await navigate('/games.html#library', `document.querySelectorAll('#favorite-grid .game-card').length===1`);
  await click('#favorite-grid [data-favorite="hash"]');
  assert.equal(await evaluate(`document.getElementById('favorites-empty').hidden`), false);
  assert.equal(await evaluate(`document.activeElement===document.querySelector('#favorites-empty a')`), true);
  pass('Favorites persist on reload; removing the last favorite restores a usable keyboard focus');
  await route('discover', 'view'); await click('#game-grid .game-card-hash .play-link');
  await until(`location.pathname==='/hash-aix.html' && document.getElementById('round-id').textContent.startsWith('#')`);
  await click('.back-lobby'); await until(`location.pathname==='/games.html' && document.getElementById('hero-resume').dataset.gameLink==='hash'`);
  assert.equal(await evaluate(`document.getElementById('resume-card').textContent.includes('哈希星盘')`), true);
  await route('activity', 'view'); assert.equal(await evaluate(`document.querySelectorAll('#recent-list .recent-row').length`), 1);
  pass('Opening a game records its real visit and updates resume and activity');
  for (const [width, height] of [[320, 740], [390, 844], [1440, 1000]]) {
    await viewport(width, height);
    for (const page of ['discover', 'library', 'activity', 'guide']) {
      await route(page, 'view'); await fits(`lobby ${width} ${page}`);
      if (page === 'discover') {
        const actions = await evaluate(`(()=>{const nav=document.querySelector('.mobile-nav'),limit=nav.getClientRects().length?nav.getBoundingClientRect().top:innerHeight;return [...document.querySelectorAll('#game-grid .play-link')].map(a=>{const r=a.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {text:a.textContent,top:r.top,bottom:r.bottom,height:r.height,limit,reachable:hit?.closest('a')===a}})})()`);
        assert.equal(actions.length, 2);
        for (const action of actions) assert.ok(action.top >= 0 && action.bottom <= action.limit && action.height >= 44 && action.reachable, `${width}px primary action: ${JSON.stringify(action)}`);
      }
    }
    pass(`Lobby discovery, library, activity and guide fit ${width}px`);
    if (width === 390) { await route('discover', 'view'); await screenshot('lobby-mobile', true); }
  }
  await route('discover', 'view'); await click('#game-grid .game-card-runner .play-link');
  await until(`location.pathname==='/run-aix.html' && document.getElementById('journey-summary').textContent.includes('/ 6')`);
  await viewport(320, 740); await fits('runner header 320');
  const runnerHome = await evaluate(`(()=>{const a=document.querySelector('.header-actions a'),r=a.getBoundingClientRect();return {visible:!!a.getClientRects().length,right:r.right,width:innerWidth}})()`);
  assert.ok(runnerHome.visible && runnerHome.right <= runnerHome.width);
  await click('.header-actions a'); await until(`location.pathname==='/games.html' && document.querySelectorAll('#game-grid .game-card').length===2`);
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(runnerKey)})`), backup[runnerKey]);
  pass('Runner links back to the lobby at 320px and preserves existing runner progress');
  // Verify clearing lobby state in another tab resets the resume CTA as well.
  await evaluate(`localStorage.removeItem(${JSON.stringify(lobbyKey)});window.dispatchEvent(new StorageEvent('storage',{key:null}))`);
  await until(`document.getElementById('hero-resume').getAttribute('href')==='#guide'`);
  assert.equal(await evaluate(`document.getElementById('hero-resume').hasAttribute('data-game-link')`), false);
  pass('Cross-tab cleared lobby state resets favorites and the resume action');
  gameEventsEnd = c.events.length;

  // Full website has no API session under the static preview. Its existing API
  // failures are outside game QA; test the real ecosystem launcher separately.
  await viewport(1440, 1000); await navigate('/index.html', `typeof openAixGames==='function'`);
  await evaluate(`document.getElementById('open-game-ecosystem').focus();document.getElementById('open-game-ecosystem').click()`);
  await until(`document.querySelector('.run-aix-dialog')?.open && document.querySelector('.run-aix-dialog iframe')?.contentDocument?.querySelectorAll('#game-grid .game-card').length===2`);
  assert.equal(await evaluate(`document.querySelector('.run-aix-dialog iframe').getAttribute('src')`), '/games.html');
  const centered = await evaluate(`(()=>{const r=document.querySelector('.run-aix-dialog').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height,vw:innerWidth,vh:innerHeight}})()`);
  assert.ok(Math.abs(centered.x * 2 + centered.w - centered.vw) < 2 && Math.abs(centered.y * 2 + centered.h - centered.vh) < 2, JSON.stringify(centered));
  assert.equal(await evaluate(`document.documentElement.style.overflow`), 'hidden');
  await screenshot('website-lobby-desktop');
  await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(`!document.querySelector('.run-aix-dialog')`);
  assert.equal(await evaluate(`document.activeElement.id`), 'open-game-ecosystem');
  assert.notEqual(await evaluate(`document.documentElement.style.overflow`), 'hidden');
  pass('Website game ecosystem opens the real lobby; Escape closes it and restores focus');
  await click('#open-game-ecosystem');
  await until(`document.querySelector('.run-aix-dialog iframe')?.contentDocument?.getElementById('exit-lobby')`);
  await evaluate(`document.querySelector('.run-aix-dialog iframe').contentDocument.getElementById('exit-lobby').click()`);
  await until(`!document.querySelector('.run-aix-dialog')`);
  await viewport(390, 844); await click('#open-game-ecosystem');
  await until(`document.querySelector('.run-aix-dialog iframe')?.contentDocument?.getElementById('exit-lobby')`);
  const modal = await evaluate(`(()=>{const r=document.querySelector('.run-aix-dialog').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,w:innerWidth,h:innerHeight}})()`);
  assert.ok(Math.abs(modal.left) < 1 && Math.abs(modal.top) < 1 && Math.abs(modal.width - modal.w) < 1 && Math.abs(modal.height - modal.h) < 1, JSON.stringify(modal));
  const phoneBack = await evaluate(`(()=>{const d=document.querySelector('.run-aix-dialog iframe').contentDocument,a=d.querySelector('.mobile-exit'),r=a.getBoundingClientRect();return {visible:!!a.getClientRects().length,height:r.height,href:a.getAttribute('href'),reachable:d.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('a')===a}})()`);
  assert.ok(phoneBack.visible && phoneBack.height >= 44 && phoneBack.reachable); assert.equal(phoneBack.href, '/index.html');
  await evaluate(`document.querySelector('.run-aix-dialog iframe').contentDocument.querySelector('.mobile-exit').click()`);
  await until(`!document.querySelector('.run-aix-dialog')`);
  await click('#open-game-ecosystem');
  await until(`document.querySelector('.run-aix-dialog iframe')?.contentDocument?.getElementById('game-grid')?.children.length===2`);
  await click('.game-launcher-bar button');
  await until(`!document.querySelector('.run-aix-dialog')`);
  pass('Desktop return, visible phone back and launcher close all exit the embedded space');
} catch (error) { report.failure = error.stack; console.error(error.stack); process.exitCode = 1; }
finally {
  try {
    if (clockId) await c.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: clockId });
    await navigate('/games.html', `document.querySelectorAll('#game-grid .game-card').length===2`);
    if (backup) await evaluate(`(()=>{const b=${JSON.stringify(backup)};for(const [k,v]of Object.entries(b)){if(k===${JSON.stringify(runnerKey)})continue;v===null?localStorage.removeItem(k):localStorage.setItem(k,v)}sessionStorage.removeItem('hash-v2-qa-clock')})()`);
    if (backup) assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(runnerKey)})`), backup[runnerKey]);
    await navigate('about:blank'); await navigate('/games.html', `document.querySelectorAll('#game-grid .game-card').length===2`);
    await viewport(1440, 1000); report.cleanedUp = true;
  } catch (error) { report.cleanupError = error.stack; process.exitCode = 1; }
  const events = c.events.slice(0, gameEventsEnd || c.events.length);
  report.errors = events.filter(e => e.method === 'Runtime.exceptionThrown' || e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error' || e.method === 'Network.responseReceived' && e.params.response.url.startsWith(origin) && e.params.response.status >= 400).map(e => ({ method: e.method, message: e.params.exceptionDetails?.text, url: e.params.response?.url, status: e.params.response?.status }));
  if (report.errors.length) process.exitCode = 1;
  report.finishedAt = new Date().toISOString(); report.ok = !process.exitCode;
  await writeFile(new URL('browser-results.json', out), JSON.stringify(report, null, 2)); c.close();
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, errors: report.errors.length, cleanedUp: report.cleanedUp }));
}
