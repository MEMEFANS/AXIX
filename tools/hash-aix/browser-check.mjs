// Isolated UI QA only. Requires the dedicated Chrome test profile on port 9233.
// The test clock controls elapsed time; random generation, hashes and payouts
// remain unchanged. Generated rounds are local QA fixtures, never user records.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { connectCDP } from '../run-aix/cdp.mjs';

const origin = 'http://127.0.0.1:4173';
const url = `${origin}/hash-aix.html`;
const browserPort = Number(process.env.HASH_QA_PORT || 9233);
const key = 'hash-aix:local:v1', settingsKey = 'hash-aix:settings:v1';
const output = new URL('./qa/', import.meta.url);
const downloads = new URL(`./qa/downloads-${Date.now()}/`, import.meta.url);
await mkdir(output, { recursive: true }); await mkdir(downloads, { recursive: true });
const cdp = await connectCDP(browserPort);
const results = { fixture: 'isolated-local-qa', startedAt: new Date().toISOString(), url, browserPort,
  method: 'Dedicated profile, real UI controls, adjustable test clock only; no seed, outcome or payout alteration.',
  checks: [], screenshots: [], errors: [] };
let clockId, storageId;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(expression) {
  const response = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(`${response.exceptionDetails.text}: ${response.exceptionDetails.exception?.description}`);
  return response.result.value;
}
async function waitFor(expression, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await evaluate(expression)) return; await sleep(50); }
  throw new Error(`Wait timed out: ${expression}`);
}
function check(name, detail) { results.checks.push({ name, pass: true, detail }); console.log('PASS', name); }
async function click(selector) {
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), true, selector);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function route(name) {
  await evaluate(`(()=>{const link=[...document.querySelectorAll('.side-nav a,.mobile-nav a')].find(link=>link.hash===${JSON.stringify('#' + name)}&&link.getClientRects().length);if(!link)throw new Error('Missing visible navigation');link.click()})()`);
  await waitFor(`!document.getElementById('page-${name}').hidden`);
}
async function navigateFresh(target = url) {
  await cdp.call('Page.navigate', { url: 'about:blank' });
  await waitFor(`location.href==='about:blank' && document.readyState==='complete'`);
  await cdp.call('Page.navigate', { url: target });
  await waitFor(`location.origin===${JSON.stringify(origin)} && document.readyState==='complete' && document.getElementById('round-id')?.textContent.startsWith('#')`);
}
const data = () => evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(key)}))`);
async function moveClock(timestamp) {
  await evaluate(`window.hashQaClock.now=${timestamp};sessionStorage.setItem('hash-aix:qa:clock',String(window.hashQaClock.now));`);
  await sleep(400);
}
async function screenshot(name, fullPage = true) {
  await evaluate(`window.scrollTo({top:0,behavior:'instant'})`); await sleep(180);
  const dimensions = await evaluate(`({width:innerWidth,height:${fullPage ? 'Math.max(innerHeight,document.documentElement.scrollHeight)' : 'innerHeight'}})`);
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage,
    clip: { x: 0, y: 0, width: dimensions.width, height: dimensions.height, scale: 1 } });
  const path = new URL(`${name}.png`, output);
  await writeFile(path, Buffer.from(shot.data, 'base64'));
  results.screenshots.push({ path: fileURLToPath(path), ...dimensions });
}
async function viewport(width, height, mobile = false) {
  await cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await cdp.call('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  await sleep(120);
}
async function assertFits(name) {
  const layout = await evaluate(`({viewport:innerWidth,width:document.documentElement.scrollWidth,overflows:[...document.querySelectorAll('main *')].filter(e=>!e.closest('[hidden]')&&e.getBoundingClientRect().right>innerWidth+1).slice(0,10).map(e=>({tag:e.tagName,class:e.className,right:e.getBoundingClientRect().right}))})`);
  assert.ok(layout.width <= layout.viewport + 1, `${name}: ${JSON.stringify(layout)}`);
}
async function submitSeed(value) {
  await evaluate(`document.getElementById('client-seed').value=${JSON.stringify(value)};document.getElementById('seed-form').requestSubmit()`);
  await waitFor(`document.getElementById('seed-message').textContent.includes('已保存')`);
}

try {
  await cdp.call('Page.enable'); await cdp.call('Runtime.enable'); await cdp.call('Network.enable');
  await cdp.call('Page.bringToFront');
  await cdp.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: fileURLToPath(downloads) });
  await viewport(1440, 1000);
  await navigateFresh();
  await evaluate(`localStorage.removeItem(${JSON.stringify(key)});localStorage.removeItem(${JSON.stringify(settingsKey)});sessionStorage.removeItem('hash-aix:qa:clock')`);
  clockId = (await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: `
    // Isolated QA clock; local random generation remains untouched.
    if(location.origin===${JSON.stringify(origin)}) {
      window.hashQaClock={now:Number(sessionStorage.getItem('hash-aix:qa:clock'))||Date.now()};
      Date.now=()=>window.hashQaClock.now;
    }
  ` })).identifier;
  await navigateFresh();
  let state = await data();
  assert.equal(state.records.length, 0); assert.equal(state.balanceCents, 100000);
  assert.equal(await evaluate(`document.getElementById('phase-pill').textContent`), '选择进行中');
  assert.equal(await evaluate(`document.getElementById('confirm').disabled`), true);
  assert.equal(state.pending.closesAt - state.pending.createdAt, 15000);
  assert.equal(state.pending.revealsAt - state.pending.closesAt, 3000);
  assert.equal(await evaluate(`document.body.innerText.includes(${JSON.stringify(state.pending.seed)})`), false);
  assert.equal(await evaluate(`document.getElementById('full-commitment').textContent`), state.pending.commitment);
  check('fresh profile: empty history, 1,000 credits, precommitted 15+3-second round', { commitment: state.pending.commitment });
  await click('#inspect-commitment'); assert.equal(await evaluate(`document.getElementById('commitment-dialog').open`), true);
  await click('#close-commitment'); assert.equal(await evaluate(`document.getElementById('commitment-dialog').open`), false);
  check('commitment dialog opens, reveals only commitment, and closes');

  await route('rules'); await submitSeed('isolated-QA-browser-v1');
  const firstClientSeed = state.pending.clientSeed;
  state = await data(); assert.equal(state.clientSeed, 'isolated-QA-browser-v1'); assert.equal(state.pending.clientSeed, firstClientSeed);
  await evaluate(`document.getElementById('client-seed').value='';document.getElementById('seed-form').requestSubmit()`);
  assert.equal(await evaluate(`document.getElementById('client-seed').validity.valueMissing`), true);
  assert.equal((await data()).clientSeed, 'isolated-QA-browser-v1');
  await evaluate(`document.getElementById('client-seed').value='isolated-QA-browser-v1'`);
  await click('#reduced-motion'); assert.equal(await evaluate(`document.body.classList.contains('reduced-motion')`), true);
  await click('#sound-toggle'); assert.equal(await evaluate(`document.getElementById('sound-toggle').getAttribute('aria-pressed')`), 'true');
  await click('#sound-toggle');
  check('rules settings: client seed is for next round; motion and sound toggles work');
  await route('game');
  await click('[data-choice="even"]');
  assert.equal(await evaluate(`document.getElementById('confirm').disabled`), false);
  await evaluate(`document.getElementById('stake').value='0';document.getElementById('stake').dispatchEvent(new Event('input',{bubbles:true}))`);
  assert.equal(await evaluate(`document.getElementById('confirm').disabled`), true);
  await click('[data-stake="20"]');
  await evaluate(`document.getElementById('confirm').click();document.getElementById('confirm').click()`);
  await waitFor(`!document.getElementById('ticket').hidden`);
  state = await data(); assert.equal(state.balanceCents, 98000); assert.equal(state.pending.choice, 'even'); assert.equal(state.pending.stakeCents, 2000);
  await click('#confirm');
  assert.equal((await data()).balanceCents, 98000);
  check('input validation and repeated confirm: exactly one 20-credit deduction');
  await screenshot('desktop-game-open');
  const pendingId = state.pending.id, commitment = state.pending.commitment;
  await moveClock(state.pending.closesAt);
  assert.equal(await evaluate(`document.getElementById('phase-pill').textContent`), '本局已锁定');
  assert.equal(await evaluate(`document.querySelectorAll('[data-choice]:disabled').length`), 4);
  assert.equal((await data()).records.length, 0);
  check('locking disables choices; no early reveal or settlement');
  await navigateFresh(); state = await data();
  assert.equal(state.pending.id, pendingId); assert.equal(state.pending.commitment, commitment); assert.equal(state.pending.choice, 'even'); assert.equal(state.balanceCents, 98000);
  assert.equal(await evaluate(`document.getElementById('ticket-detail').textContent.includes('双')`), true);
  assert.equal(await evaluate(`document.getElementById('stake').value`), '20');
  await moveClock(state.pending.revealsAt);
  await waitFor(`!document.getElementById('result-callout').hidden`);
  state = await data(); assert.equal(state.records.length, 1); assert.equal(state.pending.status, 'revealed');
  const firstRecord = state.records[0], firstBalance = state.balanceCents;
  assert.equal(firstBalance, 98000 + firstRecord.payoutCents);
  assert.equal(firstRecord.payoutCents, firstRecord.digit % 2 === 0 ? 3960 : 0);
  assert.equal(await evaluate(`document.getElementById('core-digit').textContent`), firstRecord.hexDigit.toUpperCase());
  await navigateFresh(); await sleep(600); state = await data();
  assert.equal(state.records.length, 1); assert.equal(state.balanceCents, firstBalance); assert.equal(state.pending.id, pendingId);
  check('refresh restores ticket/commitment; reveal credits and history settle exactly once', { outcome: firstRecord.hexDigit, payoutCents: firstRecord.payoutCents });
  assert.equal(await evaluate(`document.getElementById('next-round').hidden`), false);
  await moveClock(state.pending.revealsAt + 60000); assert.equal((await data()).nonce, 1);
  check('revealed round waits for manual next-round action');
  await screenshot('desktop-game-revealed');

  await route('verify'); await click('#verify-button');
  await waitFor(`document.getElementById('verification-result').textContent.includes('已复核')`);
  assert.equal(await evaluate(`document.getElementById('verification-result').classList.contains('failed')`), false);
  await screenshot('desktop-verify');
  const ledgerBefore = await evaluate(`localStorage.getItem(${JSON.stringify(key)})`);
  const mismatchingProof = { ...firstRecord, hash: '0'.repeat(64) };
  await evaluate(`document.querySelector('.manual-proof').open=true;document.getElementById('proof-json').value=${JSON.stringify(JSON.stringify(mismatchingProof))}`);
  await click('#verify-pasted');
  await waitFor(`document.getElementById('verification-result').textContent.includes('未通过')`);
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(key)})`), ledgerBefore);
  await evaluate(`document.getElementById('proof-json').value='not JSON'`); await click('#verify-pasted');
  assert.equal(await evaluate(`document.getElementById('verification-result').textContent.includes('完整')`), true);
  check('verification: actual proof passes; mismatching pasted copy and invalid JSON are rejected without changing ledger');
  await evaluate(`document.querySelector('.manual-proof').open=false;document.getElementById('proof-json').value=''`);

  await route('game'); await click('#next-round'); await waitFor(`document.getElementById('round-id').textContent==='#000002'`);
  state = await data(); assert.equal(state.pending.clientSeed, 'isolated-QA-browser-v1');
  await moveClock(state.pending.revealsAt); state = await data();
  assert.equal(state.records.length, 2); assert.equal(state.balanceCents, firstBalance); assert.equal(state.records[0].choice, null); assert.equal(state.records[0].payoutCents, 0);
  check('manual new round adopts new client seed; observation leaves credits unchanged');

  await route('history');
  assert.equal(await evaluate(`document.querySelectorAll('.history-row').length`), 2);
  await click('[data-filter="played"]'); assert.equal(await evaluate(`document.querySelectorAll('.history-row').length`), 1);
  await click('[data-filter="won"]'); assert.equal(await evaluate(`document.querySelectorAll('.history-row').length`), firstRecord.won ? 1 : 0);
  await click('[data-filter="all"]'); await click('#export-records');
  let exported;
  for (let i = 0; i < 60; i++) { try { exported = JSON.parse(await readFile(new URL('aix-hash-local-records.json', downloads), 'utf8')); break; } catch { await sleep(100); } }
  assert.equal(exported?.kind, 'local-simulation'); assert.deepEqual(exported.records, (await data()).records);
  check('history filters and actual JSON download match revealed local records');

  for (const [width, height, mobile] of [[1440, 1000, false], [390, 844, true], [320, 780, true]]) {
    await viewport(width, height, mobile);
    for (const name of ['game', 'history', 'verify', 'rules']) { await route(name); await assertFits(`${width}/${name}`); }
    if (width === 390) {
      for (const name of ['game', 'history', 'rules']) { await route(name); await screenshot(`mobile-${name}`); }
      const visibleChoice = await evaluate(`getComputedStyle(document.querySelector('.history-choice')).display`);
      results.mobileHistoryChoiceDisplay = visibleChoice;
    }
    if (width === 320) { await route('game'); await screenshot('small-game'); }
    check(`layout ${width}px: game, history, verification and rules have no horizontal overflow`);
  }
  await viewport(1440, 1000);
  await navigateFresh(`${url}#rules`);
  assert.equal(await evaluate(`document.body.classList.contains('reduced-motion')`), true);
  check('direct hash route and saved settings restore on reload');

  await cdp.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: clockId }); clockId = null;
  storageId = (await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: `
    // Isolated reliability test: simulate browsers where persistent storage is unavailable.
    Object.defineProperty(window,'localStorage',{get(){throw new DOMException('QA storage unavailable','SecurityError')}});
  ` })).identifier;
  await navigateFresh();
  assert.equal(await evaluate(`!document.getElementById('storage-notice').hidden&&document.getElementById('storage-notice').textContent.includes('存档不可用')`), true);
  await click('[data-choice="odd"]'); await click('#confirm');
  await waitFor(`!document.getElementById('ticket').hidden`);
  assert.equal(await evaluate(`document.getElementById('balance').textContent`), '990.00');
  check('unavailable browser storage: explicit notice and usable memory-only gameplay');
  await cdp.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: storageId }); storageId = null;
} catch (error) {
  results.failure = error.stack; console.error(error.stack); process.exitCode = 1;
} finally {
  try {
    if (clockId) await cdp.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: clockId });
    if (storageId) await cdp.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: storageId });
    await cdp.call('Page.navigate', { url: 'about:blank' });
    await waitFor(`location.href==='about:blank'`);
    await cdp.call('Page.navigate', { url: `${origin}/hash-aix.html` });
    await waitFor(`location.origin===${JSON.stringify(origin)}&&document.readyState==='complete'`);
    await evaluate(`localStorage.removeItem(${JSON.stringify(key)});localStorage.removeItem(${JSON.stringify(settingsKey)});sessionStorage.removeItem('hash-aix:qa:clock')`);
    await cdp.call('Page.navigate', { url: 'about:blank' });
    await cdp.call('Emulation.clearDeviceMetricsOverride');
    await cdp.call('Emulation.setTouchEmulationEnabled', { enabled: false });
    results.cleanedUp = true;
  } catch (error) { results.cleanupError = String(error); process.exitCode = 1; }
  results.errors = cdp.events.filter(event =>
    event.method === 'Runtime.exceptionThrown' ||
    event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error' ||
    event.method === 'Network.responseReceived' && event.params.response.url.startsWith(origin) && event.params.response.status >= 400
  ).map(event => ({ method: event.method, details: event.params }));
  if (results.errors.length) process.exitCode = 1;
  results.finishedAt = new Date().toISOString(); results.ok = !process.exitCode;
  await writeFile(new URL('browser-results.json', output), JSON.stringify(results, null, 2));
  cdp.close();
  console.log(JSON.stringify({ ok: results.ok, checks: results.checks.length, errors: results.errors.length, cleanedUp: results.cleanedUp }));
}
