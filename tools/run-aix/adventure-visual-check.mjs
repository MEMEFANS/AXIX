// Capture the current UI in the isolated QA browser after functional tests.
import fs from 'node:fs/promises';
import { connectCDP } from './cdp.mjs';
const browser = await connectCDP(9233), call = browser.call;
async function evaluate(expression) {
  const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}
async function ready() {
  for (let i = 0; i < 60; i++) {
    if (await evaluate("document.querySelector('.world-card') && document.getElementById('hub-art').complete && document.getElementById('hub-art').naturalWidth > 0")) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('UI did not load');
}
try {
  await call('Page.enable'); await call('Runtime.enable');
  for (const [width, height] of [[1440, 1050], [390, 844], [320, 640]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
    await call('Page.navigate', { url: 'about:blank' });
    await call('Page.navigate', { url: 'http://127.0.0.1:4173/run-aix.html#home' }); await ready();
    await evaluate("document.getElementById('toast').hidden=true; window.scrollTo(0,0)");
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await fs.writeFile(new URL(`./adventure-final-home-${width}.png`, import.meta.url), Buffer.from(shot.data, 'base64'));
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  for (const route of ['worlds', 'collection', 'records', 'settings']) {
    await evaluate(`location.hash=${JSON.stringify(route)}`); await new Promise(r => setTimeout(r, 100));
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await fs.writeFile(new URL(`./adventure-final-${route}.png`, import.meta.url), Buffer.from(shot.data, 'base64'));
  }
  console.log('Saved 7 current UI screenshots; no UI state or progress was cleared.');
} finally { browser.close(); }
