import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const publicDir = path.resolve(import.meta.dirname, '../public');
const addressA = '0x1271000000000000000000000000000000000ddb';
const addressB = '0x2342000000000000000000000000000000000eec';
const summary = { directCount: 37, teamCount: 1234, directReferrer: null };
const profile = { miners: [], stakes: [], activations: [], balances: { A: '12' }, teamLevel: { level: 0 } };
const full = { ...summary, level: 0, indirectCount: 8, directs: [], TEAM_LEVELS: [], totalEarnedA: '45.67', byKind: {} };
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  const held = new Map(), calls = [], errors = [];
  let holding = new Set(['profile']);
  let summaryMissing = false;
  const respond = (request, data) => request.respond({ contentType: 'application/json', body: JSON.stringify(data) });
  page.on('pageerror', error => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.hostname !== 'team.test') return request.abort();
    if (url.pathname === '/') return request.respond({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body>
      <div id="tab-earn" class="active"></div><script>
      currentWalletConnection={address:'${addressA}'};currentWalletProfile={authenticated:true,address:'${addressA}'};
      </script><script src="/js/portal-shared.js"></script><script src="/js/earn.js"></script><script>Portal.load('earn');</script></body>` });
    if (url.pathname.startsWith('/js/')) return request.respond({ contentType: 'text/javascript; charset=utf-8', body: fs.readFileSync(path.join(publicDir, url.pathname)) });
    const key = url.pathname.replace('/api/a-token/', '');
    calls.push(key);
    if (holding.has(key) || holding.has(url.pathname)) {
      const id = holding.has(key) ? key : url.pathname;
      if (!held.has(id)) held.set(id, []);
      held.get(id).push(request);
      return;
    }
    if (key === 'plans') return respond(request, { activation: [], staking: [] });
    if (key === 'profile') return respond(request, profile);
    if (key === 'team/summary') return summaryMissing
      ? request.respond({ status: 404, contentType: 'application/json', body: '{"error":"接口不存在"}' })
      : respond(request, summary);
    if (key === 'team/profile') return respond(request, full);
    return respond(request, {});
  });
  const heroNumbers = () => page.$$eval('.ts-stat-num', nodes => nodes.map(node => node.textContent));
  const metric = label => page.$$eval('.portal-metric', (nodes, label) => nodes.find(n => n.querySelector('span')?.textContent === label)?.querySelector('strong')?.textContent, label);
  async function waitHeld(key) {
    for (let i = 0; i < 100 && !held.get(key)?.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(held.get(key)?.length, 'Expected pending request: ' + key);
  }
  async function release(key, data) {
    const pending = held.get(key) || [];
    held.delete(key);
    await Promise.all(pending.map(request => respond(request, data)));
  }
  const started = Date.now();
  await page.goto('http://team.test/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.ts-stat-num')[1]?.textContent === '1,234人');
  const firstNumbersMs = Date.now() - started;
  assert.deepEqual(await heroNumbers(), ['37人', '1,234人']);
  await waitHeld('profile');
  assert(!calls.includes('team/profile'), 'Activation must not request full team holdings or history');
  holding.delete('profile');
  await release('profile', profile);
  await page.waitForFunction(() => !Portal.pages.earn.loading);
  assert.deepEqual(await heroNumbers(), ['37人', '1,234人'], 'Basic profile cannot erase loaded counts');

  holding = new Set(['team/profile', '/api/referrals/profile']);
  await page.evaluate(() => earnSwitch('team'));
  await waitHeld('team/profile');
  await waitHeld('/api/referrals/profile');
  assert.equal(await metric('团队总人数'), '1,234 人', 'Counts must display before detail/referral requests finish');
  await page.evaluate(() => earnSwitch('team'));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(held.get('team/profile').length, 1, 'Repeated clicks must share a pending team request');
  holding.delete('team/profile');
  await release('team/profile', full);
  await page.waitForFunction(() => [...document.querySelectorAll('.portal-metric')].some(n => n.querySelector('span')?.textContent === '团队收益总计' && n.querySelector('strong')?.textContent === '45.67 AIX'));
  assert(held.get('/api/referrals/profile')?.length, 'Income renders while invitation requests are still pending');
  await page.evaluate(() => earnSwitch('activation'));
  assert.deepEqual(await heroNumbers(), ['37人', '1,234人']);
  holding.clear();
  await release('/api/referrals/profile', { code: 'TEST', link: '/?ref=TEST' });

  // Delayed old-wallet results cannot populate the next wallet, even with a persistent cache.
  holding = new Set(['profile', 'team/summary', 'team/profile']);
  await page.evaluate(() => earnSwitch('team'));
  await waitHeld('team/summary');
  await waitHeld('team/profile');
  await page.evaluate(address => {
    currentWalletConnection = { address };
    currentWalletProfile = { authenticated: true, address };
    dispatchEvent(new CustomEvent('walletstatechange', { detail: { authenticated: true, address } }));
  }, addressB);
  await release('profile', profile);
  await release('team/summary', { ...summary, teamCount: 9876 });
  await release('team/profile', { ...full, teamCount: 9876 });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await metric('团队总人数'), '—', 'Old wallet counts cannot appear after switching');
  holding.clear();
  summaryMissing = true;
  const fullBeforeFallback = calls.filter(key => key === 'team/profile').length;
  await page.evaluate(() => earnSwitch('activation'));
  await page.waitForFunction(() => document.querySelectorAll('.ts-stat-num')[1]?.textContent === '1,234人');
  assert.equal(calls.filter(key => key === 'team/profile').length, fullBeforeFallback + 1, 'An older backend has a compatible fallback');
  assert.deepEqual(errors, []);
  const result = { first_counts_ms: firstNumbersMs, first_counts_before_miner_profile: true, details_before_invite: true,
    request_deduplication: true, wallet_switch_isolated: true, older_backend_fallback: true };
  const evidence = path.resolve(import.meta.dirname, '../../../tools/miner-speed-20261011');
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'browser-test-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
