import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { connectCDP } from './cdp.mjs';
const browser = await connectCDP(), call = browser.call, checks = [];
let injection;
async function evaluate(expression, gesture = false) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: gesture });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression, limit = 12000) {
  const start = Date.now();
  while (Date.now() - start < limit) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 60)); }
  throw new Error('Timed out: ' + expression);
}
async function open() {
  await call('Page.navigate', { url: 'http://127.0.0.1:4173/run-aix-classic.html' });
  await until("document.getElementById('account')?.textContent.includes('未登录')");
}
async function run() {
  await evaluate("document.getElementById('start').click(); document.getElementById('start').click()");
  await until("!document.getElementById('tap').disabled");
  await evaluate("window.testTaps=setInterval(()=>document.getElementById('tap').dispatchEvent(new PointerEvent('pointerdown',{button:0,bubbles:true})),16)");
}
try {
  await call('Runtime.discardConsoleEntries'); await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable'); browser.events.length = 0;
  // 固定单排障碍在右道并加速测试时钟，隔离结算流程；真实难度由引擎随机避障检查覆盖。
  injection = (await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.removeItem('run-aix:practice:v1'); Math.random=()=>.99;
    const originalRAF=window.requestAnimationFrame;
    window.requestAnimationFrame=callback=>originalRAF.call(window,time=>callback(time*3));
  ` })).identifier;
  await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 1, mobile: true });
  await open(); await run();
  assert.equal(await evaluate("document.querySelector('.controls').getBoundingClientRect().bottom <= innerHeight"), true);
  assert.equal(await evaluate("document.getElementById('credits').textContent"), '990');
  checks.push('320×568完整操作区可见；连点开始只扣一局积分');
  await until("document.getElementById('modal-title').textContent === '翻倍达成！'");
  assert.equal(await evaluate("document.getElementById('distance').textContent"), '200');
  await evaluate("document.getElementById('modal-primary').click()");
  await until("document.getElementById('modal-title').textContent === '极限 5 倍达成！'");
  assert.equal(await evaluate("document.getElementById('credits').textContent"), '1,040');
  assert.equal(await evaluate("JSON.parse(localStorage.getItem('run-aix:practice:v1')).records.length"), 1);
  checks.push('真实界面完整跑到500米，检查点继续、5倍积分、一次结算记录');
  await evaluate("clearInterval(window.testTaps); document.getElementById('modal-secondary').click()");
  await until("document.getElementById('multiplier').textContent === '0.0×'"); checks.push('锁底后返回大厅清零倍率');
  await run(); await until("Number(document.getElementById('distance').textContent)>=110");
  await evaluate("document.querySelector('.take-button').click();document.querySelector('.take-button').click();clearInterval(window.testTaps)");
  const settled = await evaluate("JSON.parse(localStorage.getItem('run-aix:practice:v1'))");
  assert.equal(settled.records.length, 2); assert.ok(settled.records[0].multiplier >= 1.1);
  checks.push('100米后主动收取；重复点击不重复结算');
  await evaluate("document.getElementById('modal-primary').click()");
  await until("!document.getElementById('tap').disabled");
  await evaluate("document.querySelector('.pause-button').focus(); document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyP',bubbles:true}))");
  assert.equal(await evaluate("document.getElementById('modal-title').textContent"), '休息一下'); checks.push('按钮持有焦点时键盘仍可暂停');
  // 模拟 bfcache 生命周期，不重载、不扣第二次积分。
  const creditsBefore = await evaluate("document.getElementById('credits').textContent");
  await evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));document.getElementById('modal-primary').click()");
  const distanceBefore = await evaluate("Number(document.getElementById('distance').textContent)");
  await until(`Number(document.getElementById('distance').textContent)>${distanceBefore + 2}`);
  assert.equal(await evaluate("document.getElementById('credits').textContent"), creditsBefore); checks.push('浏览器历史缓存恢复动画及账户监听，不重复扣积分');
  await evaluate("document.querySelector('.pause-button').click()");
  // 音频快速开关与并发恢复；使用真实浏览器 AudioContext。
  const audioResult = await evaluate(`(async()=>{
    const {GameAudio}=await import('/games/run-aix/audio.js'); const a=new GameAudio();
    await Promise.all([a.toggle(),a.toggle(),a.toggle()]);
    const enabled=a.enabled && a.context.state==='running' && !!a.timer;
    await Promise.all([a.resume(),a.resume(),a.resume()]);
    await a.suspend(); const suspended=a.context.state==='suspended' && !a.timer;
    await a.resume(); const resumed=a.context.state==='running' && !!a.timer;
    a.destroy(); await new Promise(r=>setTimeout(r,30));
    return {enabled,suspended,resumed,destroyed:a.context.state==='closed'};
  })()`, true);
  assert.deepEqual(audioResult, { enabled: true, suspended: true, resumed: true, destroyed: true }); checks.push('音乐快速开关、并发恢复、暂停及销毁正常');
  await call('Page.navigate', { url: 'http://127.0.0.1:4173/games/run-aix/launcher.css' });
  await until("document.body?.textContent.includes('.run-aix-dialog')");
  const sessionResult = await evaluate(`(async()=>{
    const {WebsiteSession}=await import('/games/run-aix/session.js'); const originalFetch=window.fetch;
    const states=[]; const resolvers=[]; window.fetch=()=>new Promise(r=>resolvers.push(r));
    const s=new WebsiteSession(state=>states.push(state));
    const a=s.refresh(), b=s.refresh();
    resolvers[1](new Response(JSON.stringify({wallet:'0x2222222222222222222222222222222222222222',balances:{A:'22'}}))); await b;
    resolvers[0](new Response(JSON.stringify({wallet:'0x1111111111111111111111111111111111111111',balances:{A:'11'}}))); await a;
    const ready=states.filter(x=>x.status==='ready');
    const c=s.refresh(); s.stop(); resolvers[2](new Response('{}')); await c;
    window.fetch=originalFetch; return {ready:ready.map(x=>x.balance),late:states.at(-1).status};
  })()`);
  assert.deepEqual(sessionResult, { ready: ['22'], late: 'loading' }); checks.push('账户请求乱序及关闭后的延迟响应不会覆盖新余额');
  // 验证真实入口模块在同源宿主下打开、返回、释放iframe。
  await evaluate("document.body.innerHTML='<button id=launch>游戏</button>';const style=document.createElement('link');style.rel='stylesheet';style.href='/games/run-aix/launcher.css';document.head.append(style)");
  await evaluate("import('/games/run-aix/launcher.js')"); await evaluate("document.getElementById('launch').focus();openRunAix();openRunAix()");
  assert.equal(await evaluate("document.querySelectorAll('.run-aix-dialog').length"), 1);
  await until("document.querySelector('iframe')?.contentDocument?.getElementById('account')?.textContent.includes('未登录')");
  await evaluate("document.querySelector('iframe').contentDocument.getElementById('back').click()");
  await until("document.querySelector('.run-aix-dialog') === null");
  assert.equal(await evaluate("document.activeElement.id"), 'launch'); checks.push('网站游戏入口防重复打开，返回释放iframe并还原焦点');
  const errors = browser.events.filter(e => e.method === 'Runtime.exceptionThrown'); assert.equal(errors.length, 0, JSON.stringify(errors));
  const writes = browser.events.filter(e => e.method === 'Network.requestWillBeSent' && !['GET', 'HEAD'].includes(e.params.request.method)); assert.equal(writes.length, 0);
  await fs.writeFile(new URL('./extended-results.json', import.meta.url), JSON.stringify({ passed: checks.length, checks, runtimeErrors: 0, assetWrites: 0 }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
  if (injection) await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection });
  await call('Page.navigate', { url: 'http://127.0.0.1:4173/run-aix-classic.html' }); browser.close();
}
