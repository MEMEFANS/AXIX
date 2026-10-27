// Same-profile concurrency QA using two dedicated local test tabs. No user tabs.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { connectCDP } from '../run-aix/cdp.mjs';
const port=Number(process.env.HASH_QA_PORT||9233),origin='http://127.0.0.1:4173',url=`${origin}/hash-aix.html`,key='hash-aix:local:v1';
const report={fixture:'isolated-two-tab-qa',startedAt:new Date().toISOString(),checks:[],errors:[]};
const a=await connectCDP(port);let b,targetId,scriptA,scriptB,backup;
await mkdir(new URL('./qa-v2/',import.meta.url),{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function connectTarget(id){
  const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json(),ws=new WebSocket(tabs.find(t=>t.id===id).webSocketDebuggerUrl),pending=new Map(),events=[];let count=0;
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(!m.id){events.push(m);return;}const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);});
  return {events,call(method,params={}){return new Promise((resolve,reject)=>{const id=++count,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout ${method}`));},10000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});},close(){ws.close();}};
}
async function evaluate(client,expression){const r=await client.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
async function waitFor(client,expression){const end=Date.now()+8000;while(Date.now()<end){if(await evaluate(client,expression))return;await sleep(50);}throw new Error(`Timeout ${expression}`);}
async function navigate(client,target){await client.call('Page.navigate',{url:target});await waitFor(client,`location.href===${JSON.stringify(target)}&&document.readyState==='complete'`);}
async function state(client){return evaluate(client,`JSON.parse(localStorage.getItem(${JSON.stringify(key)}))`);}
function check(name,detail){report.checks.push({name,pass:true,detail});console.log('PASS',name);}
try{
  await a.call('Page.enable');await a.call('Runtime.enable');await a.call('Network.enable');
  await navigate(a,`${origin}/games.html`);
  backup=await evaluate(a,`Object.fromEntries([${JSON.stringify(key)},'hash-aix:settings:v1'].map(k=>[k,localStorage.getItem(k)]))`);
  ({targetId}=await a.call('Target.createTarget',{url:'about:blank'}));b=await connectTarget(targetId);
  await b.call('Page.enable');await b.call('Runtime.enable');await b.call('Network.enable');
  const source=`if(location.origin===${JSON.stringify(origin)}){window.hashTwoTabQaTime=${Date.now()};Date.now=()=>window.hashTwoTabQaTime;}`;
  scriptA=(await a.call('Page.addScriptToEvaluateOnNewDocument',{source})).identifier;
  scriptB=(await b.call('Page.addScriptToEvaluateOnNewDocument',{source})).identifier;
  for(let attempt=1;attempt<=3;attempt++){
    await navigate(b,'about:blank');await navigate(a,url);await waitFor(a,`document.getElementById('round-id').textContent.startsWith('#')`);
    await evaluate(a,`localStorage.removeItem(${JSON.stringify(key)});localStorage.removeItem('hash-aix:settings:v1')`);await navigate(a,'about:blank');
    await Promise.all([navigate(a,url),navigate(b,url)]);
    await Promise.all([waitFor(a,`document.getElementById('round-id').textContent==='#000001'&&document.getElementById('phase-pill').textContent==='等待你的选择'`),waitFor(b,`document.getElementById('round-id').textContent==='#000001'&&document.getElementById('phase-pill').textContent==='等待你的选择'`)]);
    const [sa,sb]=await Promise.all([state(a),state(b)]);
    assert.equal(sa.pending.id,sb.pending.id);assert.equal(sa.nonce,1);assert.equal(sa.balanceCents,100000);assert.equal(sa.pending.mode,'quick');assert.equal(sa.pending.revealsAt,null);
    const status=await Promise.all([evaluate(a,`({notice:document.getElementById('storage-notice').hidden,commitment:document.getElementById('full-commitment').textContent})`),evaluate(b,`({notice:document.getElementById('storage-notice').hidden,commitment:document.getElementById('full-commitment').textContent})`)]);
    assert.ok(status.every(s=>s.notice));assert.equal(status[0].commitment,status[1].commitment);
    check(`simultaneous first navigation ${attempt}: both tabs join one active round`,{round:sa.pending.id});
  }
  await Promise.all([evaluate(a,`document.querySelector('[data-choice="odd"]').click();document.querySelector('[data-stake="20"]').click();document.getElementById('confirm').click()`),evaluate(b,`document.querySelector('[data-choice="even"]').click();document.querySelector('[data-stake="20"]').click();document.getElementById('confirm').click()`)]);
  await Promise.all([waitFor(a,`!document.getElementById('ticket').hidden`),waitFor(b,`!document.getElementById('ticket').hidden`)]);
  let sa=await state(a);assert.equal(sa.balanceCents,98000);assert.equal(sa.pending.stakeCents,2000);
  const ticketA=await evaluate(a,`document.getElementById('ticket-detail').textContent`),ticketB=await evaluate(b,`document.getElementById('ticket-detail').textContent`);assert.equal(ticketA,ticketB);
  assert.equal(await evaluate(b,`document.getElementById('stake').value`),'20');
  check('concurrent confirmation: one ticket, one deduction, both tabs display the accepted choice');
  await Promise.all([evaluate(a,`window.hashTwoTabQaTime=${sa.pending.revealsAt}`),evaluate(b,`window.hashTwoTabQaTime=${sa.pending.revealsAt}`)]);
  await Promise.all([waitFor(a,`!document.getElementById('result-callout').hidden`),waitFor(b,`!document.getElementById('result-callout').hidden`)]);
  sa=await state(a);const sb=await state(b);assert.equal(sa.records.length,1);assert.equal(sa.balanceCents,98000+sa.records[0].payoutCents);assert.deepEqual(sa,sb);
  assert.equal(await evaluate(a,`document.getElementById('balance').textContent`),await evaluate(b,`document.getElementById('balance').textContent`));
  check('both tabs reveal same record and settle payout exactly once',{outcome:sa.records[0].hexDigit,payoutCents:sa.records[0].payoutCents});
}catch(error){report.failure=error.stack;console.error(error.stack);process.exitCode=1;}
finally{
  try{
    if(scriptA)await a.call('Page.removeScriptToEvaluateOnNewDocument',{identifier:scriptA});
    if(b&&scriptB)await b.call('Page.removeScriptToEvaluateOnNewDocument',{identifier:scriptB});
    if(b)await navigate(b,'about:blank');await navigate(a,`${origin}/games.html`);
    if(backup)await evaluate(a,`(()=>{for(const [k,v]of Object.entries(${JSON.stringify(backup)})){v===null?localStorage.removeItem(k):localStorage.setItem(k,v)}})()`);
    await navigate(a,'about:blank');await navigate(a,`${origin}/games.html`);
    if(targetId)await a.call('Target.closeTarget',{targetId});report.cleanedUp=true;
  }catch(error){report.cleanupError=String(error);process.exitCode=1;}
  report.errors=[...a.events,...(b?.events||[])].filter(e=>e.method==='Runtime.exceptionThrown'||e.method==='Runtime.consoleAPICalled'&&e.params.type==='error'||e.method==='Network.responseReceived'&&e.params.response.url.startsWith(origin)&&e.params.response.status>=400).map(e=>({method:e.method,details:e.params}));if(report.errors.length)process.exitCode=1;
  report.finishedAt=new Date().toISOString();report.ok=!process.exitCode;await writeFile(new URL('./qa-v2/multitab-results.json',import.meta.url),JSON.stringify(report,null,2));b?.close();a.close();console.log(JSON.stringify({ok:report.ok,checks:report.checks.length,errors:report.errors.length,cleanedUp:report.cleanedUp}));
}
