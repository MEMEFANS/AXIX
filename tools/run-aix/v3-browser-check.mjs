import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { connectCDP } from './cdp.mjs';

const browser = await connectCDP(9233), call = browser.call;
const checks = [], metrics = {};
let injection;
async function evaluate(expression) {
  const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}
async function until(expression, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${expression}; state=${await evaluate("JSON.stringify({title:document.getElementById('modal-title')?.textContent,state:window.testEngine?.state,distance:window.testEngine?.distance,errors:window.walletRequests})")}`);
}
const data = () => evaluate("JSON.parse(localStorage.getItem('run-aix:practice:v1'))");
const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
async function screenshot(name) {
  const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fs.writeFile(new URL(`./v3-${name}.png`, import.meta.url), Buffer.from(result.data, 'base64'));
}
async function viewport(width, height) {
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
  await new Promise(resolve => setTimeout(resolve, 120));
  await evaluate('window.scrollTo(0,0)');
}
async function driver() {
  await evaluate(`(async () => {
    const { RunnerEngine } = await import('/games/run-aix/engine.js');
    if (RunnerEngine.prototype.testOriginalUpdate) return;
    const update = RunnerEngine.prototype.update;
    RunnerEngine.prototype.testOriginalUpdate = update;
    window.testFast = false;
    RunnerEngine.prototype.update = function(delta) {
      window.testEngine = this;
      if (window.testHold) return;
      for (let index = 0; index < (window.testFast ? 16 : 1); index++) {
        if (window.testCaptureAt && this.state === 'running' && this.distance >= window.testCaptureAt) { window.testHold=true; return; }
        if (window.testFast && this.state === 'running') {
          document.getElementById('tap').dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
          const upcoming = this.obstacles.filter(o => !o.passed && o.ahead > 1.5).sort((a,b) => a.ahead-b.ahead);
          if (upcoming[0]?.ahead < 22 && !upcoming[0].scripted) {
            const blocked = upcoming.filter(o => Math.abs(o.ahead-upcoming[0].ahead)<0.01).map(o=>o.lane);
            if (blocked.includes(this.lane)) {
              const safe = [0,1,2].filter(lane=>!blocked.includes(lane)).sort((a,b)=>Math.abs(a-this.lane)-Math.abs(b-this.lane))[0];
              if (safe != null) document.getElementById(safe<this.lane?'left':'right').dispatchEvent(new PointerEvent('pointerdown',{button:0,bubbles:true}));
            }
          }
        }
        update.call(this, window.testFast ? 0.05 : delta);
        if (this.state === 'checkpoint') break;
      }
    };
  })()`);
  await until('!!window.testEngine');
}
async function setRules(overrides) {
  return evaluate(`(async () => { const m=await import('/games/run-aix/rules.js');return m.saveRules({...m.DEFAULT_RULES,...${JSON.stringify(overrides)}}).revision; })()`);
}
async function fitActive(label) {
  const result = await evaluate(`(() => {
    const rect = element => { const r=element.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}; };
    return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
      controls:['left','tap','right'].map(id=>({id,...rect(document.getElementById(id))})),
      modal:document.getElementById('modal').hidden?null:rect(document.querySelector('.modal-card'))};
  })()`);
  assert.ok(result.scrollWidth <= result.width, `${label} horizontal overflow: ${JSON.stringify(result)}`);
  for (const control of result.controls) {
    if (control.height === 0 && label === 'loss320') continue;
    assert.ok(control.top >= 0 && control.bottom <= result.height && control.left >= 0 && control.right <= result.width, `${label} inaccessible control: ${JSON.stringify(control)}`);
    assert.ok(control.height >= 44 && control.width >= 44);
  }
  if (result.modal) assert.ok(result.modal.top >= 0 && result.modal.bottom <= result.height, `${label} modal overflow`);
  metrics[label] = result;
}

try {
  await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable');
  injection = (await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    let seed=20261020;Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32};
    window.walletRequests=0;window.ethereum={request(){window.walletRequests++;throw new Error('Wallet access must not occur in practice')}};
  ` })).identifier;
  await viewport(390, 844);
  await call('Page.navigate', { url: 'http://127.0.0.1:4173/run-aix-classic.html' });
  await until("!!document.getElementById('start') && document.getElementById('account').textContent.includes('未登录')");
  await evaluate("if(document.getElementById('modal-kicker').textContent==='ROUND RECOVERY')document.getElementById(document.getElementById('modal-secondary').hidden?'modal-primary':'modal-secondary').click()");
  await evaluate('localStorage.clear()'); await call('Page.reload', { ignoreCache: true });
  await until("document.getElementById('account')?.textContent.includes('未登录')");
  browser.events.length = 0;
  await driver();
  assert.match(await evaluate("document.getElementById('mode-label').textContent"), /概率模式/);
  await screenshot('lobby-390');
  await click('rules');
  const text = await evaluate("document.getElementById('modal-copy').textContent");
  assert.match(text, /60\/15\/18\/6\/1%/); assert.match(text, /所有积分、抽奖和销毁数字均为本地模拟/);
  await click('modal-primary'); checks.push('默认概率玩法、五档概率、连点规则和模拟资产说明可见');

  await evaluate('window.testCaptureAt=75;window.testFast=true;testEngine.random=()=>0.999999999');
  await click('start'); await click('start');
  await until("window.testHold && testEngine.state==='running'");
  let saved = await data(); const originalId = saved.pending.id;
  assert.equal(saved.credits, 990); assert.equal(saved.totalRounds, 1);
  await setRules({lossWeight:100,breakEvenWeight:0,smallWinWeight:0,doubleWeight:0,highWinWeight:0});
  assert.equal(await evaluate('testEngine.rules.lossWeight'),60);
  await evaluate("document.querySelector('.pause-button').click()");
  await viewport(320,568); await fitActive('playing320'); await screenshot('playing-320');
  await call('Page.reload', { ignoreCache: true });
  await until("document.getElementById('modal-title')?.textContent==='继续上次冲刺'");
  await driver(); saved = await data();
  assert.equal(saved.credits, 990); assert.equal(saved.pending.id, originalId); assert.equal(saved.totalRounds, 1);
  assert.equal(await evaluate('testEngine.id'), originalId);
  assert.equal(await evaluate('testEngine.resumeState'),'running');
  assert.equal(await evaluate('testEngine.rules.lossWeight'),60);
  assert.equal(await evaluate('testEngine.outcome.distance'),500);
  await fitActive('recovery320'); await screenshot('recovery-320');
  await click('modal-secondary'); saved = await data();
  assert.equal(saved.credits, 990); assert.equal(saved.pending, null); assert.equal(saved.consolation,0);
  checks.push('重复开始只预扣一次；刷新恢复原ID/规则/结果档，放弃不二扣不送安慰积分');

  await setRules({ lossWeight:100,breakEvenWeight:0,smallWinWeight:0,doubleWeight:0,highWinWeight:0 });
  await click('start'); await evaluate('window.testFast=true');
  await until("testEngine.state==='ended' && !document.getElementById('modal').hidden && document.getElementById('modal-kicker').textContent==='RUN COMPLETE'");
  saved=await data(); assert.equal(saved.credits,980); assert.equal(saved.consolation,10);
  assert.equal(saved.records[0].payout,0); assert.equal(saved.records[0].reason,'scheduled');
  assert.equal(saved.records[0].consolationAwarded,10); assert.ok(saved.records[0].distance<100);
  assert.equal(await evaluate("document.getElementById('modal-title').textContent"),'本局冲刺结束');
  await evaluate("document.getElementById('modal-secondary').scrollIntoView({block:'nearest'})");
  const resultButtons=await evaluate("['modal-primary','modal-secondary'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,top:r.top,bottom:r.bottom,height:r.height}})");
  for(const button of resultButtons)assert.ok(button.top>=0 && button.bottom<=568 && button.height>=39,JSON.stringify(button));
  metrics.resultButtons320=resultButtons;
  await fitActive('loss320'); await screenshot('loss-320');
  await click('modal-secondary'); await click('lottery');
  assert.match(await evaluate("document.getElementById('modal-copy').textContent"),/谢谢参与 60%/);
  await screenshot('lottery-320');
  await evaluate('Math.random=()=>0.65'); await click('modal-primary');
  assert.equal(await evaluate("document.getElementById('modal-title').textContent"),'5 试玩积分');
  saved=await data(); assert.equal(saved.consolation,0); assert.equal(saved.credits,985); assert.equal(saved.draws.length,1);
  await click('modal-secondary'); checks.push('全损规则下一局生效，安慰积分发放、固定概率抽奖花费和奖品入账正确');

  await viewport(390,844);
  await setRules({ lossWeight:0,breakEvenWeight:0,smallWinWeight:0,doubleWeight:0,highWinWeight:100 });
  await evaluate('testEngine.random=()=>0.999999999'); await click('start');
  const currentId=await evaluate('testEngine.id');
  await until("testEngine.state==='checkpoint'");
  assert.equal(await evaluate('testEngine.distance'),200);
  assert.equal(await evaluate("document.getElementById('modal-title').textContent"),'翻倍达成！');
  await fitActive('checkpoint390'); await screenshot('checkpoint-390');
  await click('modal-primary'); await until("testEngine.result?.reason==='finish'");
  assert.equal(await evaluate('testEngine.result.distance'),500);
  saved=await data(); assert.equal(saved.records[0].id,currentId); assert.equal(saved.records[0].payout,50);
  assert.equal(saved.credits,1025); assert.equal(saved.pending,null);
  await screenshot('finish-390'); await click('modal-secondary');
  checks.push('200米检查点暂停与继续正常，5倍结果到达500米并仅结算一次');

  await click('leaderboard');
  assert.equal(await evaluate("document.getElementById('modal-title').textContent"),'今日本机榜');
  assert.match(await evaluate("document.querySelector('.record-list').textContent"),/500 m5×/);
  await click('modal-primary');
  assert.equal(await evaluate("document.getElementById('modal-title').textContent"),'本机总榜');
  assert.equal(await evaluate("document.querySelectorAll('.record-row').length"),2);
  await screenshot('leaderboard-390'); await click('modal-secondary');
  checks.push('每日榜和总榜只收录本机已完成对局，作废局不进入榜单');

  await click('rules'); await viewport(320,568);
  const modalFit=await evaluate(`(() => {const card=document.querySelector('.modal-card'),r=card.getBoundingClientRect();return {width:innerWidth,height:innerHeight,left:r.left,right:r.right,top:r.top,bottom:r.bottom,client:card.clientHeight,scroll:card.scrollHeight,overflow:document.documentElement.scrollWidth}})()`);
  assert.ok(modalFit.overflow<=modalFit.width && modalFit.left>=0 && modalFit.right<=modalFit.width);
  assert.ok(modalFit.top>=0 && modalFit.bottom<=modalFit.height,JSON.stringify(modalFit));
  await evaluate("document.getElementById('modal-primary').scrollIntoView({block:'end'})");
  await screenshot('rules-320'); await click('modal-primary');
  metrics.rules320=modalFit; checks.push('320×568与390×844操作区完整可用，长说明在弹框内部滚动且按钮可达');

  await evaluate('window.testCaptureAt=350;window.testHold=false;testEngine.random=()=>0.999999999');
  await click('start'); await until("testEngine.state==='checkpoint'"); await click('modal-primary');
  await until('!!window.testHold'); await fitActive('live320'); await screenshot('live-320');
  await viewport(390,844); await fitActive('live390'); await screenshot('live-390');
  metrics.live={distance:await evaluate('testEngine.distance'),speed:await evaluate('testEngine.speed'),state:await evaluate('testEngine.state')};
  assert.equal(metrics.live.state,'running'); assert.ok(metrics.live.distance>=350);

  assert.equal(await evaluate('window.walletRequests'),0);
  const apiRequests=browser.events.filter(event=>event.method==='Network.requestWillBeSent' && new URL(event.params.request.url).pathname.startsWith('/api/')).map(event=>({url:event.params.request.url,method:event.params.request.method}));
  assert.ok(apiRequests.length>0); assert.ok(apiRequests.every(request=>request.method==='GET' && request.url.endsWith('/api/a-token/profile')),JSON.stringify(apiRequests));
  const errors=browser.events.filter(event=>event.method==='Runtime.exceptionThrown'); assert.deepEqual(errors,[]);
  metrics.apiRequests=apiRequests; checks.push('账户仅GET读取profile，无钱包调用或资产POST请求，浏览器runtime异常为零');
  const result={ok:true,checks,count:checks.length,metrics};
  await fs.writeFile(new URL('./v3-browser-results.json',import.meta.url),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} catch(error) {
  await screenshot('failure').catch(()=>{});
  console.error(error);
  console.error(JSON.stringify(browser.events.filter(event=>event.method==='Runtime.exceptionThrown'),null,2));
  process.exitCode=1;
} finally {
  if(injection) await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:injection});
  browser.close();
}
