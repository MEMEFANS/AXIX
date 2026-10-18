import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const publicDir = path.resolve(import.meta.dirname, '../public');
const auditDir = path.resolve(import.meta.dirname, '../../../tools/aix-chart-20261011');
fs.mkdirSync(auditDir, { recursive:true });
const baseline = process.env.AIX_CHART_BASELINE === '1';
const source = baseline ? path.join(auditDir, 'before/public/js/a-token-trade.js') : path.join(publicDir, 'js/a-token-trade.js');
const steps = { '1m':60, '5m':300, '15m':900, '1h':3600, '4h':14400, '1d':86400 };
function candles(period, count) {
  const step = steps[period], start = 1791676800 - count * step;
  return Array.from({ length:count }, (_, i) => {
    const open = 0.1234 + Math.sin(i / 5) * 0.003;
    const close = open + (i % 2 ? -0.0008 : 0.0008);
    return { time:start + i * step, open, close, high:Math.max(open, close) + 0.0006, low:Math.min(open, close) - 0.0006 };
  });
}
const fixtures = Object.fromEntries(Object.keys(steps).map(p => [p, candles(p, p === '1d' ? 2 : 500)]));
const result = { baseline, scenarios:[], measurements:[] }, errors = [];
const browser = await puppeteer.launch({ executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
const mark = name => { result.scenarios.push(name); console.log('PASS: ' + name); };
const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const measure = page => page.evaluate(() => {
  const scale = testChart.timeScale(), data = testSeries.data(), range = scale.getVisibleLogicalRange();
  const lastIndex = data.length - 1;
  return {
    count:data.length, spacing:scale.options().barSpacing, paneWidth:scale.width(), range,
    pixelGap:data.length ? scale.logicalToCoordinate(lastIndex) - scale.logicalToCoordinate(lastIndex - 1) : null,
    lastX:data.length ? scale.logicalToCoordinate(lastIndex) : null,
  };
});
try {
  for (const viewport of [{ width:1440, height:1000 }, { width:390, height:844, isMobile:true, hasTouch:true }]) {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport(viewport);
    await page.setContent('<!DOCTYPE html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div class="main-content"><div id="tab-a-token-trade" class="tab-panel portal-page active"></div></div></body></html>');
    await page.addStyleTag({ path:path.join(publicDir, 'styles/critical.css') });
    await page.addStyleTag({ path:path.join(publicDir, 'styles/lazy.css') });
    await page.addScriptTag({ path:path.join(publicDir, 'js/theme.js') });
    await page.addScriptTag({ path:path.join(publicDir, 'vendor/lightweight-charts.js') });
    await page.evaluate(fixtures => {
      window.fixtures = fixtures;
      window.holdKlines = false;
      window.pendingKlines = [];
      window.Portal = {
        esc:value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])),
        active:() => true, walletKey:() => '', loading:() => '加载中',
        header:(title, description) => `<div class="portal-header"><h2>${title}</h2><p>${description}</p></div>`,
        walletGate:() => '', register:(_name, config) => { window.aixPage = config; },
        readJSON:async url => {
          const parsed = new URL(url, 'http://chart.test');
          if (parsed.pathname.endsWith('/kline')) {
            const period = parsed.searchParams.get('period'), limit = Number(parsed.searchParams.get('limit'));
            const data = { candles:JSON.parse(JSON.stringify(fixtures[period].slice(-limit))) };
            if (holdKlines) return new Promise(resolve => pendingKlines.push({ period, limit, data, resolve }));
            return data;
          }
          if (parsed.pathname.endsWith('/pool')) return { priceUsdt:0.1234, recentTrades:[] };
          if (parsed.pathname.endsWith('/orderbook')) return { bids:[], asks:[], markPrice:0.1234 };
          return {};
        },
      };
      window.loadPageCharts = () => Promise.resolve();
      const create = LightweightCharts.createChart;
      window.LightweightCharts = { ...LightweightCharts, createChart:(...args) => {
        const chart = create(...args), add = chart.addSeries.bind(chart);
        window.testChart = chart;
        chart.addSeries = (...args) => { window.testSeries = add(...args); return testSeries; };
        return chart;
      } };
    }, fixtures);
    await page.addScriptTag({ path:source });
    await page.evaluate(async () => { aixPage.render(); await aixPage.load(); });
    await page.waitForFunction(() => window.testSeries?.data().length === 500);
    await paint(page);
    for (const period of ['1m', '5m', '15m', '1h', '4h', '1d']) {
      await page.click(`.atrade-chart-tabs button[data-period="${period}"]`);
      await paint(page);
      const metrics = await measure(page);
      result.measurements.push({ viewport:viewport.width, period, ...metrics });
      if (!baseline) {
        assert.equal(metrics.count, fixtures[period].length, 'Keep all real history available');
        assert(metrics.spacing >= 8 && metrics.spacing <= 14, 'Readable default candle spacing');
        assert(Math.abs(metrics.pixelGap - metrics.spacing) < 0.01, 'Measure rendered candle spacing');
        assert(metrics.lastX >= 0 && metrics.lastX < metrics.paneWidth, 'Latest candle visible');
        assert(metrics.range.to - metrics.range.from < 150, 'Do not squeeze all 500 candles into the viewport');
        assert.equal(await page.evaluate(() => testChart.timeScale().options().timeVisible), period !== '1d');
      }
      if (period === '15m' || period === '1d') {
        await page.$eval('#atrade-chart', node => node.scrollIntoView({ block:'center' }));
        await (await page.$('.atrade-cell-chart')).screenshot({ path:path.join(auditDir, `${baseline ? 'before' : 'after'}-${viewport.width}-${period}.png`) });
      }
    }
    if (baseline) { await page.close(); continue; }
    mark(`${viewport.width}px: all 6 periods use readable candles with latest price visible`);

    for (const count of [1, 12]) {
      await page.evaluate(data => { fixtures['1d'] = data; }, candles('1d', count));
      await page.evaluate(() => atradeSwitchPeriod('1d'));
      await paint(page);
      const metrics = await measure(page);
      assert.equal(metrics.count, count);
      assert.equal(metrics.spacing, 9);
      assert(metrics.lastX > 0 && metrics.lastX < metrics.paneWidth);
    }
    mark(`${viewport.width}px: sparse daily history remains 9px wide without fabricated candles`);

    await page.evaluate(() => atradeSwitchPeriod('1m'));
    await paint(page);
    await page.evaluate(() => testChart.timeScale().setVisibleLogicalRange({ from:400, to:430 }));
    await paint(page);
    const panned = await measure(page);
    await page.evaluate(() => {
      const data = fixtures['1m'], last = data.at(-1);
      data.push({ ...last, time:last.time + 60 });
      return atradeRefreshKline();
    });
    await paint(page);
    const refreshed = await measure(page);
    assert.equal(refreshed.count, 501);
    assert(Math.abs(panned.spacing - refreshed.spacing) < 0.01);
    assert(Math.abs(panned.range.from - refreshed.range.from) < 0.01);
    assert(Math.abs(panned.range.to - refreshed.range.to) < 0.01);
    mark(`${viewport.width}px: live new candles preserve historical pan and zoom`);

    await page.evaluate(() => atradeSwitchPeriod('1m'));
    await paint(page);
    const latest = await measure(page);
    await page.evaluate(() => {
      const data = fixtures['1m'], last = data.at(-1);
      data.push({ ...last, time:last.time + 60 });
      return atradeRefreshKline();
    });
    await paint(page);
    const following = await measure(page);
    assert(Math.abs(following.spacing - latest.spacing) < 0.01);
    assert(Math.abs(following.lastX - latest.lastX) < 0.01);
    mark(`${viewport.width}px: live view follows the latest candle without changing width`);

    await page.setViewport({ ...viewport, width:viewport.width === 390 ? 720 : 980 });
    await paint(page);
    const resized = await measure(page);
    assert.equal(resized.spacing, 12);
    assert(resized.lastX > 0 && resized.lastX < resized.paneWidth);
    mark(`${viewport.width}px: resizing changes visible candle count, not candle width`);

    await page.evaluate(() => {
      window.holdKlines = true;
      window.oldRefresh = atradeRefreshKline();
      window.switchFive = atradeSwitchPeriod('5m');
      window.switchBack = atradeSwitchPeriod('1m');
    });
    assert.equal(await page.evaluate(() => pendingKlines.length), 3);
    await page.evaluate(async () => {
      holdKlines = false;
      pendingKlines[2].resolve(pendingKlines[2].data);
      await switchBack;
      const old = pendingKlines[0], last = old.data.candles.at(-1);
      old.resolve({ candles:[{ ...last, time:last.time + 60, close:999, high:1000 }] });
      pendingKlines[1].resolve(pendingKlines[1].data);
      await Promise.all([oldRefresh, switchFive]);
      pendingKlines = [];
    });
    await paint(page);
    assert.equal((await measure(page)).spacing, 12);
    assert.equal(await page.evaluate(() => testSeries.data().at(-1).close), fixtures['1m'].at(-1).close);
    mark(`${viewport.width}px: stale refresh and rapid period switching cannot overwrite new data`);

    await page.evaluate(() => { fixtures['1d'] = []; return atradeSwitchPeriod('1d'); });
    assert.equal(await page.evaluate(() => testSeries.data().length), 0);
    await page.evaluate(data => { fixtures['1d'] = data; return atradeRefreshKline(); }, candles('1d', 1));
    await paint(page);
    assert.equal((await measure(page)).count, 1);
    assert.equal((await measure(page)).spacing, 9);
    mark(`${viewport.width}px: empty periods clear old candles and can receive their first live candle`);
    await page.evaluate(() => aixPage.deactivate());
    await page.close();
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(auditDir, baseline ? 'baseline-result.json' : 'browser-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
