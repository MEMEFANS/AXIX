import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const result = { mobileViewport: true, walletConnected: false, panels: [], runtimeErrors: [], blockedMutations: [], failedScripts: [] };
const output = path.resolve(import.meta.dirname, '../../../../tools/page-loading-20261011/production-browser.json');
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !url.pathname.endsWith('/api/hyperliquid/info')) {
      result.blockedMutations.push({ path: url.pathname, method: request.method() });
      return request.abort();
    }
    return request.continue();
  });
  page.on('pageerror', error => result.runtimeErrors.push(error.message));
  page.on('response', response => {
    if (response.request().resourceType() === 'script' && !response.ok()) {
      result.failedScripts.push({ path: new URL(response.url()).pathname, status: response.status() });
    }
  });
  const navigation = await page.goto('https://axix.cc/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  assert.equal(navigation.status(), 200);
  await page.waitForFunction(() => typeof switchTab === 'function' && typeof loadPageModule === 'function', { timeout: 15000 });
  result.startup = await page.evaluate(() => ({
    activePanel: document.querySelector('.tab-panel.active')?.id,
    pageLoaderVersion: [...document.scripts].find(s => s.src.includes('/js/page-loader.js'))?.src,
    chartDownloaded: [...document.scripts].some(s => s.src.includes('/vendor/lightweight-charts.js')),
  }));
  assert(result.startup.pageLoaderVersion.includes('20261011-pages-1'));
  assert.equal(result.startup.activePanel, 'tab-earn');
  assert.equal(result.startup.chartDownloaded, false);
  const names = await page.evaluate(() => [...document.querySelectorAll('.tab-panel')].map(n => n.id.replace('tab-', '')));
  for (const name of names) {
    const started = Date.now();
    const accepted = await page.evaluate(name => switchTab(name), name);
    assert.equal(accepted, true, name + ' navigation failed');
    const state = await page.evaluate(name => ({ active: document.getElementById('tab-' + name)?.classList.contains('active'), moduleReady: window.isPageModuleReady(name), busy: document.getElementById('tab-' + name)?.getAttribute('aria-busy') }), name);
    assert.equal(state.active, true);
    assert.equal(state.moduleReady, true);
    assert.equal(state.busy, null);
    result.panels.push({ name, moduleLoaded: true, navigationMs: Date.now() - started });
  }
  await page.evaluate(() => switchTab('earn'));
  await page.waitForFunction(() => typeof window.LightweightCharts === 'object', { timeout: 15000 });
  result.chartLibraryLoadedOnDemand = true;
  assert.equal(result.panels.length, 20);
  assert.deepEqual(result.failedScripts, []);
  assert.deepEqual(result.runtimeErrors, []);
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.error = error.message;
  process.exitCode = 1;
} finally {
  await browser.close();
  result.checkedAtUtc = new Date().toISOString();
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
