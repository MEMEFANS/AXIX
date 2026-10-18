const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const app = path.resolve(__dirname, '../../resources/app');
const puppeteer = createRequire(path.join(app, 'package.json'))('puppeteer');
const result = { passed:false, production:true, checks:[], measurements:[], runtimeErrors:[], blockedUnexpectedWrites:[] };
let browser;
(async () => {
  try {
    browser = await puppeteer.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
    for (const viewport of [{ width:1440, height:1000 }, { width:390, height:844, isMobile:true, hasTouch:true }]) {
      const page = await browser.newPage();
      const scripts = [];
      page.on('pageerror', error => result.runtimeErrors.push(error.message));
      await page.setViewport(viewport);
      await page.setRequestInterception(true);
      page.on('request', request => {
        const uri = new URL(request.url());
        if (uri.pathname === '/cdn-cgi/rum') return request.abort();
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
          result.blockedUnexpectedWrites.push({ path:uri.pathname, method:request.method() });
          return request.abort();
        }
        if (uri.pathname.endsWith('.js')) scripts.push(uri.pathname + uri.search);
        return request.continue();
      });
      await page.evaluateOnNewDocument(() => {
        let library;
        Object.defineProperty(window, 'LightweightCharts', {
          configurable:true,
          get:() => library,
          set:value => {
            library = { ...value, createChart:(host, options) => {
              const chart = value.createChart(host, options);
              if (host.id === 'atrade-chart') {
                window.testAixChart = chart;
                const add = chart.addSeries.bind(chart);
                chart.addSeries = (...args) => {
                  window.testAixSeries = add(...args);
                  return testAixSeries;
                };
              }
              return chart;
            } };
          },
        });
      });
      await page.goto('https://axix.cc/', { waitUntil:'domcontentloaded', timeout:40000 });
      await page.waitForFunction(() => typeof switchTab === 'function', { timeout:25000 });
      await page.evaluate(() => switchTab('a-token-trade'));
      await page.waitForFunction(() => window.testAixSeries?.data().length > 0, { timeout:25000 });
      const loadedScripts = await page.evaluate(() => [...document.scripts].map(script => {
        const uri = new URL(script.src || location.href);
        return uri.pathname + uri.search;
      }));
      assert(loadedScripts.includes('/js/page-loader.js?v=20261011-aix-chart-1'));
      assert(loadedScripts.includes('/js/a-token-trade.js?v=20261011-aix-chart-1'));
      for (const [period, expected] of Object.entries({ '1m':12, '5m':12, '15m':12, '1h':11, '4h':10, '1d':9 })) {
        await page.evaluate(period => atradeSwitchPeriod(period), period);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const metrics = await page.evaluate(() => {
          const scale = testAixChart.timeScale(), data = testAixSeries.data();
          return { count:data.length, spacing:scale.options().barSpacing, paneWidth:scale.width(), lastX:data.length ? scale.logicalToCoordinate(data.length - 1) : null, timeVisible:scale.options().timeVisible };
        });
        assert.equal(metrics.spacing, expected);
        assert.equal(metrics.timeVisible, period !== '1d');
        if (metrics.count) assert(metrics.lastX >= 0 && metrics.lastX < metrics.paneWidth);
        assert.equal(await page.$eval('.atrade-chart-tabs button.active', node => node.dataset.period), period);
        result.measurements.push({ viewport:viewport.width, period, ...metrics });
      }
      result.checks.push(`${viewport.width}px: online chart loads both new script versions and displays all 6 periods at their intended widths`);
      await page.evaluate(() => atradeSwitchPeriod('15m'));
      await (await page.$('.atrade-cell-chart')).screenshot({ path:path.join(__dirname, `online-${viewport.width}-15m.png`) });
      await page.close();
    }
    assert.deepEqual(result.runtimeErrors, []);
    assert.deepEqual(result.blockedUnexpectedWrites, []);
    result.passed = true;
  } catch (error) {
    result.error = error.message;
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(__dirname, 'public-browser-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  }
})();
