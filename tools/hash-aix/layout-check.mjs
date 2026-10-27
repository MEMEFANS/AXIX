// Final visual QA in the isolated test browser. Never opens a production page.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { connectCDP } from '../run-aix/cdp.mjs';
const origin='http://127.0.0.1:4173', base=`${origin}/hash-aix.html`, key='hash-aix:local:v1';
const output=new URL('./qa/',import.meta.url); await mkdir(output,{recursive:true});
const cdp=await connectCDP(Number(process.env.HASH_QA_PORT||9233));
const report={fixture:'isolated-local-visual-qa',startedAt:new Date().toISOString(),checks:[],screenshots:[],errors:[]};
let injection;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function evaluate(expression){const r=await cdp.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
async function waitFor(expression){const end=Date.now()+8000;while(Date.now()<end){if(await evaluate(expression))return;await sleep(50);}throw new Error(`Timeout: ${expression}`);}
async function fresh(){await cdp.call('Page.navigate',{url:'about:blank'});await waitFor(`location.href==='about:blank'`);await cdp.call('Page.navigate',{url:base});await waitFor(`document.readyState==='complete'&&document.getElementById('round-id')?.textContent.startsWith('#')`);}
async function viewport(width,height){await cdp.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600});await sleep(100);}
async function route(name){await evaluate(`location.hash=${JSON.stringify(name)}`);await waitFor(`!document.getElementById('page-${name}').hidden`);}
async function fits(name){const d=await evaluate(`({w:innerWidth,scroll:document.documentElement.scrollWidth,over:[...document.querySelectorAll('main *')].filter(e=>!e.closest('[hidden]')&&e.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(e=>({tag:e.tagName,class:e.className,right:e.getBoundingClientRect().right}))})`);assert.ok(d.scroll<=d.w+1,`${name}: ${JSON.stringify(d)}`);report.checks.push({name,pass:true});console.log('PASS',name);}
async function shot(name,full=true){await waitFor(`document.getElementById('toast')?.hidden!==false`);await evaluate(`window.scrollTo({top:0,behavior:'instant'})`);await sleep(120);const d=await evaluate(`({width:innerWidth,height:${full?'Math.max(innerHeight,document.documentElement.scrollHeight)':'innerHeight'}})`);const s=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:full,clip:{x:0,y:0,...d,scale:1}});const path=new URL(`${name}.png`,output);await writeFile(path,Buffer.from(s.data,'base64'));report.screenshots.push({path:fileURLToPath(path),...d});}
async function pointerClick(selector){const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,visible:r.width>0&&r.height>0}})()`);assert.equal(p.visible,true,selector);await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',buttons:1,clickCount:1});await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',buttons:0,clickCount:1});}
try{
  await cdp.call('Page.enable');await cdp.call('Runtime.enable');await cdp.call('Network.enable');await cdp.call('Page.bringToFront');
  await viewport(1440,1000);await fresh();
  await evaluate(`localStorage.removeItem(${JSON.stringify(key)});localStorage.removeItem('hash-aix:settings:v1')`);
  injection=(await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:`if(location.origin===${JSON.stringify(origin)}){window.hashVisualQaNow=Date.now();Date.now=()=>window.hashVisualQaNow;}` })).identifier;
  await fresh();
  await shot('desktop-game-ready');
  await viewport(390,844);await shot('mobile-game-ready');await shot('mobile-game-ready-viewport',false);
  await viewport(320,780);await shot('small-game-ready');
  for(const width of [1440,390,320]){
    await viewport(width,width===1440?1000:844);
    for(const name of ['game','history','verify','rules']){await route(name);await fits(`${width}px ${name}`);}
    if(width===390){await shot('mobile-rules');}
    if(width===320){await shot('small-rules');}
    await route('game');
    await pointerClick(width===1440?'.runner-link':'.footer-runner');
    await waitFor(`location.pathname==='/run-aix.html'&&document.readyState==='complete'&&document.getElementById('home-worlds')?.children.length===3`);
    await fits(`${width}px runner lobby`);
    await pointerClick('.hash-discovery');
    await waitFor(`location.pathname==='/hash-aix.html'&&document.getElementById('round-id')?.textContent.startsWith('#')`);
    report.checks.push({name:`${width}px real pointer navigation: hash → runner → hash`,pass:true});
  }
  await viewport(1440,1000);await route('rules');
  await evaluate(`document.getElementById('client-seed').value='isolated-visual-QA';document.getElementById('seed-form').requestSubmit()`);
  await waitFor(`document.getElementById('seed-message').textContent.includes('已保存')`);
  await route('game');await evaluate(`document.querySelector('[data-choice="small"]').click();document.getElementById('confirm').click()`);
  await waitFor(`!document.getElementById('ticket').hidden`);
  await evaluate(`window.hashVisualQaNow=JSON.parse(localStorage.getItem(${JSON.stringify(key)})).pending.revealsAt`);
  await waitFor(`!document.getElementById('result-callout').hidden`);
  await shot('desktop-game-revealed');
  await route('verify');await evaluate(`document.getElementById('verify-button').click()`);await waitFor(`document.getElementById('verification-result').textContent.includes('已复核')`);await shot('desktop-verify');
  await viewport(390,844);await route('game');await shot('mobile-game');await fits('390px revealed game');
  await route('history');await shot('mobile-history');await fits('390px populated history');
  assert.notEqual(await evaluate(`getComputedStyle(document.querySelector('.history-choice')).display`),'none');
  report.checks.push({name:'mobile history shows chosen prediction and stake',pass:true});
  await viewport(320,780);await route('history');await fits('320px populated history');await route('verify');await fits('320px populated proof');await shot('small-verify');
}catch(error){report.failure=error.stack;process.exitCode=1;console.error(error.stack);}
finally{
  try{if(injection)await cdp.call('Page.removeScriptToEvaluateOnNewDocument',{identifier:injection});await fresh();await evaluate(`localStorage.removeItem(${JSON.stringify(key)});localStorage.removeItem('hash-aix:settings:v1')`);await cdp.call('Page.navigate',{url:'about:blank'});await cdp.call('Emulation.clearDeviceMetricsOverride');report.cleanedUp=true;}catch(error){report.cleanupError=String(error);process.exitCode=1;}
  report.errors=cdp.events.filter(e=>e.method==='Runtime.exceptionThrown'||e.method==='Runtime.consoleAPICalled'&&e.params.type==='error'||e.method==='Network.responseReceived'&&e.params.response.url.startsWith(origin)&&e.params.response.status>=400).map(e=>({method:e.method,details:e.params}));if(report.errors.length)process.exitCode=1;
  report.finishedAt=new Date().toISOString();report.ok=!process.exitCode;await writeFile(new URL('layout-results.json',output),JSON.stringify(report,null,2));cdp.close();console.log(JSON.stringify({ok:report.ok,checks:report.checks.length,errors:report.errors.length,cleanedUp:report.cleanedUp}));
}
