// Integrated local adventure QA. Runs only in the dedicated test browser profile.
// Autopilot sends ordinary lane-change input and advances the real engine with
// 50 ms updates. It never changes rules, hazards, results or profile records.
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Use Node's WebSocket implementation for control frames, fragmentation and
// connection-close handling during genuine pointer gestures.
async function connectBrowser(port) {
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target=targets.find(item=>item.type==='page');
  assert.ok(target,'Test browser needs a page target');
  const socket=new WebSocket(target.webSocketDebuggerUrl),pending=new Map(),events=[];
  let sequence=0;
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',event=>{
    const message=JSON.parse(event.data);
    if(!message.id){events.push(message);return;}
    const item=pending.get(message.id);if(!item)return;
    clearTimeout(item.timer);pending.delete(message.id);
    message.error?item.reject(new Error(JSON.stringify(message.error))):item.resolve(message.result);
  });
  socket.addEventListener('close',event=>{
    for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error(`CDP socket closed: ${event.code} ${event.reason}`));}
    pending.clear();
  });
  return {events,call(method,params={}){return new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},15000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  });},close(){socket.close();}};
}

const base = 'http://127.0.0.1:4173/run-aix.html';
const output = new URL('./adventure-browser-results.json', import.meta.url);
const browserPort = Number(process.env.ADVENTURE_QA_PORT || 9233);
const cdp = await connectBrowser(browserPort);
const results = { startedAt: new Date().toISOString(), url: base, browserPort,
  method: 'Isolated browser; actual UI/controller, ordinary lane input, real engine advanced in <=50ms steps. No rules or result alterations.', checks: [], errors: [] };
let instrumentationId;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(expression) {
  let response;
  try { response = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); }
  catch(error) { throw new Error(`${error.message}; expression: ${expression.slice(0,240)}`, {cause:error}); }
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text + ': ' + response.exceptionDetails.exception?.description);
  return response.result.value;
}
function check(name, detail) { results.checks.push({ name, pass: true, detail }); console.log('PASS', name); }
async function waitFor(expression, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await evaluate(expression)) return; await sleep(40); }
  throw new Error('Wait timed out: ' + expression);
}
async function click(selector) {
  assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), true, selector);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function point(selector) {
  return evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
}
async function pressMouse(position) {
  await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',...position,button:'left',buttons:1,clickCount:1});
}
async function releaseMouse(position) {
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',...position,button:'left',buttons:0,clickCount:1});
}
async function route(name) { await evaluate(`location.hash=${JSON.stringify(name)}`); await waitFor(`!document.getElementById('view-${name}').hidden`); }
async function navigateFresh(url) {
  // A same-URL or hash navigation can preserve the old document. Always leave
  // its execution context first so module wrappers and lexical bindings reset.
  await cdp.call('Page.navigate', { url: 'about:blank' });
  await waitFor(`location.href==='about:blank' && document.readyState==='complete'`);
  await cdp.call('Page.navigate', { url });
  await waitFor(`location.href===${JSON.stringify(url)} && document.readyState==='complete' && document.getElementById('home-worlds')?.children.length===3`);
}
async function screenshot(name) {
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(new URL(`./adventure-qa-${name}.png`, import.meta.url), Buffer.from(shot.data, 'base64'));
}
async function installHarness() {
  await evaluate(`(async()=>{
    const {CampaignEngine}=await import('/games/run-aix/campaign-engine.js');
    const marker=Symbol.for('run-aix.qa.harness.v1');
    if(CampaignEngine.prototype[marker]) return;
    Object.defineProperty(CampaignEngine.prototype,marker,{value:true});
    const start=CampaignEngine.prototype.start, update=CampaignEngine.prototype.update;
    CampaignEngine.prototype.start=function(...args){
      window.qaEngine=this; this.qaWarnings=[];
      const onEvent=this.qaOriginalEvent || (this.qaOriginalEvent=this._campaignOnEvent);
      this._campaignOnEvent=(name,data)=>{
        if(name==='warning') this.qaWarnings.push({id:data.id,lane:data.lane,distance:Math.round((this.distance+data.ahead)*1e6)/1e6});
        onEvent(name,data);
      };
      return start.apply(this,args);
    };
    CampaignEngine.prototype.update=function(dt){
      if(window.qaAutopilot && this.state==='running'){
        const obstacles=this.obstacles.filter(o=>!o.passed && o.ahead>=0);
        const first=Math.min(Infinity,...obstacles.map(o=>o.ahead));
        const blocked=new Set(obstacles.filter(o=>Math.abs(o.ahead-first)<1).map(o=>o.lane));
        const available=[0,1,2].filter(lane=>!blocked.has(lane));
        const crystal=this.collectibles.filter(c=>!c.collected && c.ahead>0).sort((a,b)=>a.ahead-b.ahead)[0];
        let target=available.includes(this.lane)?this.lane:available.sort((a,b)=>Math.abs(a-this.lane)-Math.abs(b-this.lane))[0];
        if(crystal && available.includes(crystal.lane) && crystal.ahead<first+2) target=crystal.lane;
        if(target!==undefined && target!==this.lane) this.move(Math.sign(target-this.lane));
      }
      return update.call(this,dt);
    };
  })()`);
}
async function runToEnd() {
  await waitFor(`window.qaEngine && ['running','countdown'].includes(window.qaEngine.state)`);
  const result = await evaluate(`(async()=>{
    window.qaAutopilot=true;
    let steps=0;
    while(!['ended','paused'].includes(qaEngine.state) && steps<8000){
      for(let i=0;i<100 && !['ended','paused'].includes(qaEngine.state);i++,steps++) qaEngine.update(.05);
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    window.qaAutopilot=false;
    return {steps,result:qaEngine.result,state:qaEngine.state,warnings:qaEngine.qaWarnings};
  })()`);
  assert.equal(result.state, 'ended'); assert.equal(result.result?.completed, true);
  await waitFor(`document.getElementById('game-dialog').open && !document.getElementById('dialog-title').textContent.includes('星光会等你')`);
  return result;
}

try {
  await cdp.call('Page.enable'); await cdp.call('Runtime.enable'); await cdp.call('Network.enable');
  await cdp.call('Page.bringToFront');
  await cdp.call('Page.navigate', { url: 'about:blank' });
  await waitFor(`location.href==='about:blank' && document.readyState==='complete'`);
  ({ identifier: instrumentationId } = await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
    if(window.__adventureQaInstrumentation) return;
    window.__adventureQaInstrumentation=true;
    window.qaWrites=[];window.qaPageErrors=[];
    const originalSetItem=Storage.prototype.setItem;
    Storage.prototype.setItem=function(k,v){window.qaWrites.push(k);return originalSetItem.call(this,k,v)};
    addEventListener('error',e=>window.qaPageErrors.push({message:e.message,file:e.filename}));
    addEventListener('unhandledrejection',e=>window.qaPageErrors.push({rejection:String(e.reason)}));
  })();` }));
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await navigateFresh(base);
  await evaluate(`localStorage.removeItem('run-aix:player-profile:v1')`);
  await navigateFresh(base);
  await installHarness(); await installHarness(); // Explicitly exercise idempotence.
  for (const view of ['home','worlds','collection','records','settings','guide']) {
    await route(view);
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('.view')).filter(v=>!v.hidden).length`), 1);
  }
  check('Six distinct routes render', ['home','worlds','collection','records','settings','guide']);
  await route('worlds');
  const locks=await evaluate(`Array.from(document.querySelectorAll('[data-level]')).map(n=>({id:n.dataset.level,disabled:n.disabled}))`);
  assert.equal(locks.length,6); assert.equal(locks[0].disabled,false); assert.equal(locks.slice(1).every(x=>x.disabled),true);
  await click('[data-level="level-6"]');
  assert.equal(await evaluate(`document.getElementById('play-screen').hidden`),true);
  check('Fresh progression locks levels 2–6',locks);
  await route('settings'); await click('#setting-reducedMotion');
  assert.equal(await evaluate(`document.body.classList.contains('reduced-motion')`),true);
  await route('home'); await click('#start-training'); await waitFor(`window.qaEngine?.state==='countdown'`);
  await click('#pause-game'); await waitFor(`qaEngine.state==='paused'&&document.getElementById('game-dialog').open`);
  const pausedDistance=await evaluate(`qaEngine.distance`); await sleep(150);
  assert.equal(await evaluate(`qaEngine.distance`),pausedDistance);
  await click('#dialog-primary'); await waitFor(`qaEngine.state==='countdown'`);
  check('Pause/resume during countdown keeps distance frozen',pausedDistance);
  await evaluate(`for(let i=0;i<65&&qaEngine.state==='countdown';i++)qaEngine.update(.05)`);
  await waitFor(`qaEngine.state==='running' && !document.getElementById('boost').disabled`);
  // Exercise browser pointer events through the actual canvas handlers.
  const canvasCenter=await point('#world');
  await pressMouse({x:canvasCenter.x-45,y:canvasCenter.y});
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:canvasCenter.x+45,y:canvasCenter.y,buttons:1});
  await releaseMouse({x:canvasCenter.x+45,y:canvasCenter.y});
  assert.equal(await evaluate(`qaEngine.lane`),2);
  await pressMouse({x:canvasCenter.x+45,y:canvasCenter.y});
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:canvasCenter.x-45,y:canvasCenter.y,buttons:1});
  await releaseMouse({x:canvasCenter.x-45,y:canvasCenter.y});
  assert.equal(await evaluate(`qaEngine.lane`),1);
  check('Real canvas pointer swipes change right and left lanes',{rightLane:2,leftLane:1});
  // Do not fast-forward this check: real held-pointer input must feed the
  // controller's animation loop, raise the engine tap rate and then release.
  await sleep(250);
  const beforeBoost=await evaluate(`({distance:qaEngine.distance,speed:qaEngine.speed,rocket:qaEngine.rocketActive})`);
  const boostCenter=await point('#boost');
  await pressMouse(boostCenter); await sleep(1250);
  const heldBoost=await evaluate(`({distance:qaEngine.distance,speed:qaEngine.speed,rocket:qaEngine.rocketActive,held:document.getElementById('boost').classList.contains('held')})`);
  assert.ok(heldBoost.distance>beforeBoost.distance); assert.ok(heldBoost.speed>beforeBoost.speed);
  assert.equal(heldBoost.rocket,true); assert.equal(heldBoost.held,true);
  await releaseMouse(boostCenter); await sleep(1250);
  const releasedBoost=await evaluate(`({distance:qaEngine.distance,speed:qaEngine.speed,rocket:qaEngine.rocketActive,held:document.getElementById('boost').classList.contains('held')})`);
  assert.ok(releasedBoost.distance>heldBoost.distance); assert.ok(releasedBoost.speed<heldBoost.speed);
  assert.equal(releasedBoost.rocket,false); assert.equal(releasedBoost.held,false);
  await pressMouse(boostCenter); await sleep(800);
  await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'p',code:'KeyP',windowsVirtualKeyCode:80});
  await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'p',code:'KeyP',windowsVirtualKeyCode:80});
  await waitFor(`qaEngine.state==='paused' && document.getElementById('game-dialog').open`);
  assert.equal(await evaluate(`document.getElementById('boost').classList.contains('held')`),false);
  await releaseMouse(boostCenter); await click('#dialog-primary'); await sleep(1250);
  const resumedCruise=await evaluate(`({state:qaEngine.state,distance:qaEngine.distance,rocket:qaEngine.rocketActive,held:document.getElementById('boost').classList.contains('held')})`);
  assert.equal(resumedCruise.state,'running'); assert.equal(resumedCruise.rocket,false); assert.equal(resumedCruise.held,false);
  assert.ok(resumedCruise.distance>releasedBoost.distance);
  check('Real held boost accelerates, release cruises, and pause releases held input',{beforeBoost,heldBoost,releasedBoost,resumedCruise});
  const training=await runToEnd();
  assert.equal(training.result.levelId,'training');
  assert.equal(await evaluate(`Object.keys(JSON.parse(localStorage.getItem('run-aix:player-profile:v1')).completed).length`),0);
  check('Training reaches real 200m summary without unlocking campaign',training.result);
  await screenshot('training-summary');
  await click('#dialog-primary'); await waitFor(`qaEngine.levelId==='level-1'`);
  // Advance countdown only, then test keyboard and a regular running pause.
  await evaluate(`for(let i=0;i<65&&qaEngine.state==='countdown';i++)qaEngine.update(.05)`);
  await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
  await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
  assert.equal(await evaluate(`qaEngine.lane`),0);
  await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  assert.equal(await evaluate(`qaEngine.lane`),1);
  await click('#pause-game'); await waitFor(`qaEngine.state==='paused'`);
  await click('#dialog-primary'); await waitFor(`qaEngine.state==='running'`);
  check('Keyboard lane controls and running pause/resume work',await evaluate(`({state:qaEngine.state,lane:qaEngine.lane})`));
  const campaigns=[];
  for(let i=1;i<=6;i++) {
    const run=await runToEnd(); assert.equal(run.result.levelId,`level-${i}`); campaigns.push(run.result);
    if(i<6){await click('#dialog-primary'); await waitFor(`qaEngine.levelId==='level-${i+1}'`);}
  }
  assert.ok(campaigns.every(r=>r.hits===0));
  check('Six campaign levels finish through lane input and sequential summaries',campaigns);
  await screenshot('campaign-summary'); await click('#dialog-secondary'); await waitFor(`document.getElementById('play-screen').hidden`);
  await route('worlds');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-level]')).every(n=>!n.disabled)`),true);
  await route('collection');
  const skins=await evaluate(`Array.from(document.querySelectorAll('[data-skin]')).map(n=>({id:n.dataset.skin,disabled:n.disabled}))`);
  assert.equal(skins.find(s=>s.id==='nebula').disabled,false);
  await click('[data-skin="nebula"]');
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('run-aix:player-profile:v1')).selectedSkin`),'nebula');
  check('Earned stars unlock collection and skin selection writes profile',skins);
  await route('home'); await click('#start-daily');
  assert.equal(await evaluate(`document.getElementById('game-dialog').open`),true);
  assert.equal(await evaluate(`document.getElementById('play-screen').hidden`),true);
  check('Daily preview waits for start',await evaluate(`document.getElementById('dialog-copy').textContent`));
  await click('#dialog-primary'); await waitFor(`qaEngine.levelId==='daily'`); const dailyOne=await runToEnd();
  await click('#dialog-primary'); await waitFor(`qaEngine.levelId==='daily' && qaEngine.state==='countdown'`); const dailyTwo=await runToEnd();
  assert.deepEqual(dailyOne.warnings,dailyTwo.warnings);
  assert.ok(dailyOne.warnings.length>0);
  check('Daily retry has identical seeded road', { first:dailyOne.result,second:dailyTwo.result,warningCount:dailyOne.warnings.length,warnings:dailyOne.warnings });
  // Launch just before China midnight, finish after it, and retain the route day.
  await evaluate(`window.qaOriginalNow=Date.now; Date.now=()=>Date.UTC(2029,0,1,15,59,59,900)`);
  await click('#dialog-primary'); await waitFor(`qaEngine.levelId==='daily' && qaEngine.state==='countdown'`);
  await evaluate(`Date.now=()=>Date.UTC(2029,0,1,16,0,5)`);
  const midnightRun=await runToEnd();
  const midnightDaily=await evaluate(`JSON.parse(localStorage.getItem('run-aix:player-profile:v1')).daily`);
  assert.equal(midnightDaily['2029-01-01'].completed,true);
  assert.equal(midnightDaily['2029-01-02'],undefined);
  await evaluate(`Date.now=window.qaOriginalNow; delete window.qaOriginalNow`);
  check('A daily run finished after China midnight stays on its launch-day route', {completed:midnightRun.result.completed,recordDay:'2029-01-01'});
  await click('#dialog-secondary'); await waitFor(`document.getElementById('play-screen').hidden`);
  const writes=await evaluate(`window.qaWrites`);
  assert.ok(writes.length>0); assert.deepEqual([...new Set(writes)],['run-aix:player-profile:v1']);
  check('Adventure writes only its separate player profile', [...new Set(writes)]);
  const saved=await evaluate(`JSON.parse(localStorage.getItem('run-aix:player-profile:v1'))`);
  await navigateFresh(base+'#collection'); await waitFor(`document.querySelector('[data-skin="nebula"]')?.textContent.includes('已装备')`);
  assert.equal(await evaluate(`document.getElementById('setting-reducedMotion').checked`),true);
  const reloaded=await evaluate(`JSON.parse(localStorage.getItem('run-aix:player-profile:v1'))`);
  assert.deepEqual(reloaded,saved); await installHarness();
  check('Campaign, daily records, equipped skin and settings survive reload',{completed:Object.keys(saved.completed),stars:Object.values(saved.completed).reduce((a,r)=>a+r.stars,0),selectedSkin:saved.selectedSkin,settings:saved.settings,totalRuns:saved.totalRuns});
  for(const [width,height] of [[320,640],[390,844],[1440,1000]]) {
    await cdp.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600});
    const routes=[];
    for(const name of ['home','worlds','collection','records','settings','guide']){
      await route(name); await sleep(70);
      const measure=await evaluate(`({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth})`);
      assert.ok(measure.scrollWidth<=width+1,`${width} ${name} document overflow ${measure.scrollWidth}`);
      routes.push({name,...measure});
    }
    await route('home'); await screenshot(`${width}-home`);
    await click('#start-training'); await waitFor(`qaEngine?.state==='countdown'`); await sleep(70);
    const controls=await evaluate(`['pause-game','move-left','move-right','boost','world'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return{id,x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}})`);
    assert.ok(controls.every(r=>r.x>=-1&&r.y>=-1&&r.right<=width+1&&r.bottom<=height+1),`${width}: controls outside viewport: ${JSON.stringify(controls)}`);
    await screenshot(`${width}-play`); await click('#pause-game'); await click('#dialog-secondary'); await waitFor(`document.getElementById('play-screen').hidden`);
    check(`${width}×${height} routes have no horizontal overflow and play controls fit`,{routes,controls});
  }
  await route('home'); await evaluate(`window.scrollTo(0,document.body.scrollHeight)`); await sleep(200);
  const pageErrors=await evaluate(`window.qaPageErrors`);
  const exceptions=cdp.events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails);
  const failed=cdp.events.filter(e=>e.method==='Network.loadingFailed'&&!e.params.canceled).map(e=>e.params);
  const statuses=cdp.events.filter(e=>e.method==='Network.responseReceived'&&e.params.response.status>=400).map(e=>({url:e.params.response.url,status:e.params.response.status}));
  const broken=await evaluate(`Array.from(document.images).filter(i=>i.complete&&!i.naturalWidth).map(i=>i.src)`);
  assert.deepEqual(pageErrors,[]); assert.deepEqual(exceptions,[]); assert.deepEqual(failed,[]); assert.deepEqual(statuses,[]); assert.deepEqual(broken,[]);
  check('No JS exceptions, rejected promises, failed requests, HTTP errors or broken loaded images',{pageErrors,exceptionCount:exceptions.length,requestFailures:failed,statuses,broken});
  results.passed=true;
}catch(error){results.passed=false;results.errors.push({message:error.message,stack:error.stack});console.error(error);await screenshot('failure').catch(()=>{});process.exitCode=1;}
finally{
  if(instrumentationId) await cdp.call('Page.removeScriptToEvaluateOnNewDocument',{identifier:instrumentationId}).catch(error=>results.errors.push({cleanup:error.message}));
  results.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(results,null,2)+'\n');cdp.close();
}
