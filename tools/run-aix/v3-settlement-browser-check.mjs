import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { connectCDP } from './cdp.mjs';

const browser = await connectCDP(9233), call=browser.call, checks=[];
async function evaluate(expression) {
  const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression) {
  const started=Date.now();
  while(Date.now()-started<8000){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,40));}
  throw new Error(`Timed out: ${expression}`);
}
const click=id=>evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
const data=()=>evaluate("JSON.parse(localStorage.getItem('run-aix:practice:v1'))");
async function capture() {
  await evaluate(`(async()=>{
    const {RunnerEngine}=await import('/games/run-aix/engine.js');
    const {PracticeStore}=await import('/games/run-aix/store.js');
    const update=RunnerEngine.prototype.update,settle=PracticeStore.prototype.settle;
    RunnerEngine.prototype.update=function(dt){window.testEngine=this;return update.call(this,dt)};
    PracticeStore.prototype.settle=function(result){window.testStore=this;if(window.rejectSettlement)return false;return settle.call(this,result)};
  })()`);
  await until('!!window.testEngine');
}
try {
  await call('Runtime.enable');await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await call('Page.navigate',{url:'http://127.0.0.1:4173/run-aix-classic.html'});
  await until("document.getElementById('account')?.textContent.includes('未登录')");
  await evaluate("if(document.getElementById('modal-kicker').textContent==='ROUND RECOVERY')document.getElementById(document.getElementById('modal-secondary').hidden?'modal-primary':'modal-secondary').click()");
  await evaluate('localStorage.clear()');await call('Page.reload',{ignoreCache:true});
  await until("document.getElementById('account')?.textContent.includes('未登录')");
  await evaluate("(async()=>{const r=await import('/games/run-aix/rules.js');r.saveRules({...r.DEFAULT_RULES,lossWeight:100,breakEvenWeight:0,smallWinWeight:0,doubleWeight:0,highWinWeight:0});})()");
  await capture(); browser.events.length=0;
  await click('start');
  await evaluate("testEngine.state='running';testEngine.end('scheduled')");
  await until("document.getElementById('modal-kicker').textContent==='RUN COMPLETE' && !document.getElementById('modal').hidden");
  let saved=await data();const credits=saved.credits,consolation=saved.consolation;
  assert.equal(credits,990);assert.equal(consolation,10);
  await evaluate("testEngine.onEvent('end',{...testEngine.result})");
  await until("document.getElementById('modal-kicker').textContent==='RUN COMPLETE'");
  saved=await data();assert.equal(saved.credits,credits);assert.equal(saved.consolation,consolation);assert.equal(saved.records.length,1);
  checks.push('重复同 ID、门槛、返还、距离、倍率均一致时恢复结果展示，不重复记账');

  await evaluate("testEngine.onEvent('end',{...testEngine.result,payout:10,multiplier:1,distance:100})");
  assert.equal(await evaluate("document.getElementById('modal-kicker').textContent"),'SAVE FAILED');
  await click('modal-primary');assert.equal(await evaluate("document.getElementById('modal-kicker').textContent"),'SAVE FAILED');
  saved=await data();assert.equal(saved.credits,credits);assert.equal(saved.records.length,1);
  assert.equal(await evaluate("document.querySelector('.take-button').hidden && document.querySelector('.pause-button').hidden && document.getElementById('banner').textContent===''") ,true);
  checks.push('同 ID 但结果不一致仍拒绝结算，重试不加分，游戏按钮与横幅已收尾');

  await click('modal-secondary');await until("document.getElementById('account')?.textContent.includes('未登录')");
  await capture();await click('start');await evaluate("window.rejectSettlement=true;testEngine.state='running';testEngine.end('scheduled')");
  assert.equal(await evaluate("document.getElementById('modal-kicker').textContent"),'SAVE FAILED');
  saved=await data();const pendingId=saved.pending.id;assert.equal(saved.credits,980);
  await click('modal-primary');saved=await data();assert.equal(saved.pending.id,pendingId);assert.equal(saved.credits,980);
  assert.equal(await evaluate("document.getElementById('modal-secondary').textContent"),'恢复未完成对局');
  await click('modal-secondary');await until("document.getElementById('modal-title')?.textContent==='继续上次冲刺'");
  saved=await data();assert.equal(saved.pending.id,pendingId);assert.equal(saved.credits,980);
  await click('modal-secondary');saved=await data();assert.equal(saved.pending,null);assert.equal(saved.credits,980);assert.equal(saved.consolation,10);
  await until("!document.getElementById('lottery').disabled");
  checks.push('真实 pending 结算失败保留原对局；重试不扣分，恢复按钮重新加载并可放弃解除 pending');

  await evaluate("Storage.prototype.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='run-aix:practice:v1')throw new DOMException('quota','QuotaExceededError');return this.originalSetItem(key,value)};Math.random=()=>0.65");
  await click('lottery');await click('modal-primary');
  assert.equal(await evaluate("document.getElementById('modal-title').textContent"),'5 试玩积分');
  const copy=await evaluate("document.getElementById('modal-copy').textContent");
  assert.match(copy,/本次页面内已结算/);assert.match(copy,/刷新后可能丢失/);assert.doesNotMatch(copy,/已保存在本机/);
  assert.equal(await evaluate("document.getElementById('credits').textContent"),'985');
  assert.equal(await evaluate("document.getElementById('consolation').textContent"),'0');
  saved=await data();assert.equal(saved.credits,980);assert.equal(saved.consolation,10);assert.equal(saved.draws.length,0);
  checks.push('抽奖存储写入失败时仅内存发奖，并明确告知刷新可能丢失，不再声称已持久保存');

  assert.deepEqual(browser.events.filter(event=>event.method==='Runtime.exceptionThrown'),[]);
  const result={ok:true,count:checks.length,checks,runtimeExceptions:0};
  await fs.writeFile(new URL('./v3-settlement-browser-results.json',import.meta.url),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}finally{await call('Browser.close').catch(()=>{});browser.close();}
