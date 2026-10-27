import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { connectCDP } from './cdp.mjs';

const browser=await connectCDP(9233),call=browser.call;
async function evaluate(expression){
  const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression){
  const start=Date.now();
  while(Date.now()-start<8000){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,40));}
  throw new Error(`Timed out: ${expression}`);
}
try{
  await call('Runtime.enable');await call('Page.enable');
  await call('Page.navigate',{url:'http://127.0.0.1:4173/run-aix-classic.html'});
  await until("document.getElementById('account')?.textContent.includes('未登录')");
  await evaluate("if(document.getElementById('modal-kicker').textContent==='ROUND RECOVERY')document.getElementById(document.getElementById('modal-secondary').hidden?'modal-primary':'modal-secondary').click()");
  await evaluate('localStorage.clear()');await call('Page.reload',{ignoreCache:true});
  await until("document.getElementById('account')?.textContent.includes('未登录')");
  browser.events.length=0;
  // 独立测试浏览器中的另一个 store 实例，模拟另一标签已预扣的有效对局。
  const expected=await evaluate(`(async()=>{
    const {PracticeStore}=await import('/games/run-aix/store.js');
    const {RunnerEngine}=await import('/games/run-aix/engine.js');
    const engine=new RunnerEngine();engine.start(10);
    const store=new PracticeStore();const opened=store.beginRound(10,engine.id,engine.snapshot());
    return {ok:opened.ok,id:engine.id,credits:store.data.credits};
  })()`);
  assert.equal(expected.ok,true);assert.equal(expected.credits,990);
  await evaluate("document.getElementById('start').click()");
  assert.equal(await evaluate("document.getElementById('modal-kicker').textContent"),'ROUND UNAVAILABLE');
  assert.match(await evaluate("document.getElementById('modal-copy').textContent"),/已有未完成对局/);
  assert.equal(await evaluate("document.getElementById('modal-primary').textContent"),'恢复未完成对局');
  let saved=await evaluate("JSON.parse(localStorage.getItem('run-aix:practice:v1'))");
  assert.equal(saved.credits,990);assert.equal(saved.pending.id,expected.id);assert.equal(saved.totalRounds,1);
  await evaluate("document.getElementById('modal-primary').click()");
  await until("document.getElementById('modal-title')?.textContent==='继续上次冲刺'");
  saved=await evaluate("JSON.parse(localStorage.getItem('run-aix:practice:v1'))");
  assert.equal(saved.credits,990);assert.equal(saved.pending.id,expected.id);assert.equal(saved.totalRounds,1);
  assert.deepEqual(browser.events.filter(event=>event.method==='Runtime.exceptionThrown'),[]);
  const result={ok:true,count:1,check:'另一标签存在pending时提供中文恢复入口，重新加载恢复原ID且不重复预扣',runtimeExceptions:0};
  await fs.writeFile(new URL('./v3-pending-browser-results.json',import.meta.url),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}finally{await call('Browser.close').catch(()=>{});browser.close();}
