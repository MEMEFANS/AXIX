import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { connectCDP } from './cdp.mjs';
const browser = await connectCDP(); const call = browser.call; const checks = [];
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression, limit = 8000) {
  const start = Date.now(); while (Date.now() - start < limit) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Timed out: ' + expression);
}
try {
  await call('Runtime.discardConsoleEntries');
  await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable');
  browser.events.length = 0;
  await call('Page.navigate', { url: 'http://127.0.0.1:4173/run-aix-classic.html' });
  await until("document.getElementById('account')?.textContent.includes('未登录')");
  assert.equal(await evaluate("document.getElementById('balance').textContent"), '—'); checks.push('无会话不虚构余额、不弹钱包');
  for (const [width, height] of [[430, 932], [390, 844], [375, 667], [320, 568], [1440, 1080]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await evaluate("document.getElementById('start').getBoundingClientRect().bottom <= document.querySelector('.stage').getBoundingClientRect().bottom"), true);
  }
  checks.push('430/390/375/320手机与1440桌面布局无横向溢出，启动按钮在场景内');
  await call('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 1, mobile: true });
  await evaluate("document.querySelector('[data-stake=\"50\"]').click()");
  assert.equal(await evaluate("document.getElementById('stake').value"), '50'); checks.push('参与积分快捷选择');
  await evaluate("document.querySelector('[data-stake=\"10\"]').click(); document.getElementById('start').click()");
  await until("!document.getElementById('tap').disabled");
  const before = await evaluate("Number(document.getElementById('distance').textContent)");
  await evaluate("document.getElementById('right').dispatchEvent(new PointerEvent('pointerdown',{button:0,bubbles:true})); for(let i=0;i<10;i++) document.getElementById('tap').dispatchEvent(new PointerEvent('pointerdown',{button:0,bubbles:true}));");
  await until(`Number(document.getElementById('distance').textContent) > ${before + 3}`);
  checks.push('倒计时、触屏输入、距离推进');
  await evaluate("document.querySelector('.pause-button').click()");
  assert.equal(await evaluate("document.getElementById('modal-title').textContent"), '休息一下');
  const paused = await evaluate("document.getElementById('distance').textContent");
  await new Promise(r => setTimeout(r, 250)); assert.equal(await evaluate("document.getElementById('distance').textContent"), paused);
  await evaluate("document.getElementById('modal-primary').click()"); checks.push('暂停冻结距离、继续恢复');
  await call('Runtime.evaluate', { expression: "document.getElementById('sound').click()", userGesture: true });
  await until("document.getElementById('sound').getAttribute('aria-pressed') === 'true'"); checks.push('用户点击后开启 Web Audio 音乐');
  await evaluate("document.getElementById('sound').click()");
  await call('Page.navigate', { url: 'http://127.0.0.1:4173/run-aix-classic.html' });
  await until("document.getElementById('account')?.textContent.includes('未登录')");
  await evaluate("document.getElementById('rules').click()"); assert.equal(await evaluate("document.getElementById('modal-title').textContent"), '手速点燃星际旅程');
  await evaluate("document.getElementById('modal-primary').click(); document.getElementById('records').click()");
  assert.equal(await evaluate("document.getElementById('modal-title').textContent"), '每一步都算数');
  await evaluate("document.getElementById('modal-primary').click()"); checks.push('玩法说明、本机纪录弹窗');
  // 同源宿主夹具只存在于测试浏览器：验证已有会话与切换事件，不连接真实钱包。
  // 使用静态文本建立无运行中游戏脚本的同源测试宿主。
  await call('Page.navigate', { url: 'http://127.0.0.1:4173/games/run-aix/launcher.css' });
  await until("document.body?.textContent.includes('.run-aix-dialog')");
  await evaluate(`(async()=>{
    document.body.innerHTML='<iframe id="fixture" src="/run-aix-classic.html" style="width:430px;height:932px"></iframe>';
    window.currentWalletProfile={authenticated:true,address:'0x1111111111111111111111111111111111111111'};
    await new Promise(r=>document.getElementById('fixture').onload=r);
    const child=document.getElementById('fixture').contentWindow;
    child.fetch=async()=>new Response(JSON.stringify({wallet:window.currentWalletProfile.address,balances:{A:'1234.56789'}}),{status:200,headers:{'Content-Type':'application/json'}});
    window.dispatchEvent(new Event('walletstatechange'));
  })()`);
  await until("document.getElementById('fixture').contentDocument.getElementById('balance').textContent === '1,234.5678'");
  await evaluate("window.currentWalletProfile={authenticated:false};window.dispatchEvent(new Event('walletstatechange'))");
  await until("document.getElementById('fixture').contentDocument.getElementById('balance').textContent === '—'");
  checks.push('同源已登录账户读取 AIX，断开事件清除余额，不重连接');
  const mutations = browser.events.filter(e => e.method === 'Network.requestWillBeSent' && !['GET','HEAD'].includes(e.params.request.method));
  assert.equal(mutations.length, 0); checks.push('整个流程未发起资产写入请求');
  const errors = browser.events.filter(e => e.method === 'Runtime.exceptionThrown'); assert.equal(errors.length, 0, JSON.stringify(errors));
  await call('Page.navigate', { url: 'http://127.0.0.1:4173/run-aix-classic.html' });
  await until("document.getElementById('account')?.textContent.includes('未登录')");
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fs.writeFile(new URL('./lobby-mobile.png', import.meta.url), Buffer.from(screenshot.data, 'base64'));
  await fs.writeFile(new URL('./browser-results.json', import.meta.url), JSON.stringify({ passed: checks.length, checks, runtimeErrors: 0, assetWrites: 0 }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally { browser.close(); }
