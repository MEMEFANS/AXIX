import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { connectCDP } from './cdp.mjs';

const browser = await connectCDP(), call = browser.call;
let injection;
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression, limit = 16000) {
  const start = Date.now();
  while (Date.now() - start < limit) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error('Timed out: ' + expression);
}
try {
  await call('Runtime.enable'); await call('Page.enable');
  injection = (await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    let seed = 20261020;
    Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  ` })).identifier;
  await call('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 1, mobile: true });
  await call('Page.navigate', { url: 'http://127.0.0.1:4173/run-aix-classic.html' });
  await until("document.getElementById('account')?.textContent.includes('未登录')");
  browser.events.length = 0;
  // Only the isolated test browser gets this driver. Hazards, speed and collision rules stay real.
  await evaluate(`(async () => {
    const { RunnerEngine } = await import('/games/run-aix/engine.js');
    const update = RunnerEngine.prototype.update;
    window.testMoves = 0; window.captureDone = false;
    RunnerEngine.prototype.update = function(delta) {
      window.testEngine = this;
      if (this.state === 'running') {
        const pointer = id => document.getElementById(id).dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
        pointer('tap');
        const upcoming = this.obstacles.filter(o => !o.passed && o.ahead > 1.5).sort((a, b) => a.ahead - b.ahead);
        if (upcoming[0]?.ahead < 18) {
          const blocked = upcoming.filter(o => Math.abs(o.ahead - upcoming[0].ahead) < .01).map(o => o.lane);
          if (blocked.includes(this.lane)) {
            const safe = [0, 1, 2].filter(lane => !blocked.includes(lane)).sort((a, b) => Math.abs(a - this.lane) - Math.abs(b - this.lane))[0];
            pointer(safe < this.lane ? 'left' : 'right'); window.testMoves++;
          }
        }
        if (this.distance >= 350 && !window.captureDone) { window.captureDone = true; this.pause(); }
      } else if (this.state === 'checkpoint') document.getElementById('modal-primary').click();
      return update.call(this, delta);
    };
    document.getElementById('start').click();
  })()`);
  await until("window.captureDone && window.testEngine.state === 'paused'");
  const sample = await evaluate(`({ distance: testEngine.distance, speed: testEngine.speed, moves: testMoves,
    hazards: testEngine.obstacles.filter(o => !o.passed).length })`);
  assert.ok(sample.speed > 48 && sample.moves >= 9 && sample.hazards >= 3, JSON.stringify(sample));
  // Hide only the pause overlay for an unobstructed screenshot; the engine remains frozen.
  await evaluate("document.getElementById('modal').hidden = true");
  const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fs.writeFile(new URL('./gameplay-v5-mobile.png', import.meta.url), Buffer.from(shot.data, 'base64'));
  await evaluate("document.getElementById('modal-primary').click()");
  await until("window.testEngine.result?.reason === 'finish'");
  assert.equal(await evaluate('window.testEngine.result.distance'), 500);
  assert.equal(browser.events.filter(event => event.method === 'Runtime.exceptionThrown').length, 0);
  const result = { passed: 1, check: '真实高难随机赛道：通过触屏按钮连续换道、全速通过检查点并完成500米，无脚本异常', sample };
  await fs.writeFile(new URL('./difficulty-browser-results-v5.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (injection) await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection });
  await call('Page.navigate', { url: 'http://127.0.0.1:4173/run-aix-classic.html' });
  browser.close();
}
