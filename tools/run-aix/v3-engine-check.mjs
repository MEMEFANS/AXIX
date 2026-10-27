import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { RunnerEngine } from '../../resources/app/public/games/run-aix/engine.js';
import { DEFAULT_RULES, chooseOutcome, normalizeRules, multiplierForDistance } from '../../resources/app/public/games/run-aix/rules.js';
import { OBSTACLES } from '../../resources/app/public/games/run-aix/config.js';

const checks = [], failures = [], metrics = {};
const check = (name, run) => {
  try { run(); checks.push(name); }
  catch (error) { failures.push({ name, message: error.message, stack: error.stack }); }
};
const seeded = initial => { let seed = initial >>> 0; return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; }; };
const ticketRandom = (ticket, distanceTicket = 0, seed = 17) => {
  const initial = [ticket, distanceTicket], random = seeded(seed);
  return () => initial.length ? initial.shift() : random();
};
function running({ mode = 'skill', random = seeded(30), rules = {}, onEvent = () => {} } = {}) {
  const engine = new RunnerEngine({ random, onEvent, rules: { ...DEFAULT_RULES, mode, ...rules } });
  assert(engine.start(10));
  for (let frame = 0; frame < 62 && engine.state === 'countdown'; frame++) engine.update(.05);
  assert.equal(engine.state, 'running');
  return engine;
}
function isolate(engine) { engine.obstacles = []; engine.nextSpawnDistance = Infinity; return engine; }
function drive(engine, { frameLimit = 6000, dt = .05, tapEvery = 2, dodge = false, onCheckpoint } = {}) {
  let frames = 0;
  while (engine.state !== 'ended' && frames < frameLimit) {
    if (engine.state === 'checkpoint') { if (onCheckpoint) onCheckpoint(engine); else engine.continue(); }
    if (engine.state === 'running') {
      if (frames % tapEvery === 0) engine.tap();
      if (dodge) {
        const upcoming = engine.obstacles.filter(obstacle => !obstacle.passed && !obstacle.scripted && obstacle.ahead > 1.5).sort((a,b) => a.ahead-b.ahead);
        if (upcoming[0]?.ahead < 18) {
          const row = upcoming.filter(obstacle => Math.abs(obstacle.ahead - upcoming[0].ahead) < .01);
          if (row.some(obstacle => obstacle.lane === engine.lane)) {
            const safe = [0,1,2].filter(lane => !row.some(obstacle => obstacle.lane === lane)).sort((a,b) => Math.abs(a-engine.lane)-Math.abs(b-engine.lane))[0];
            if (safe !== undefined) engine.move(Math.sign(safe-engine.lane));
          }
        }
      }
    }
    engine.update(dt); frames++;
  }
  assert.equal(engine.state, 'ended', `did not finish in ${frameLimit} frames, d=${engine.distance}, state=${engine.state}`);
  return engine.result;
}
const hazard = (id, lane=1, ahead=1.6, extra={}) => ({ ...OBSTACLES.find(obstacle => obstacle.id === id), lane, ahead, passed:false, ...extra });

check('skill: initial one-second input grace then >0.2s inactivity fails', () => {
  const engine = isolate(running());
  for (let i=0;i<20;i++) engine.update(.05);
  assert.equal(engine.state,'running');
  engine.update(.05); assert.equal(engine.result.reason,'stumble'); assert.equal(engine.result.payout,0);
  const exact = isolate(running()); exact.time=2; exact.inputGraceUntil=0; exact.tap();
  for(let i=0;i<4;i++)exact.update(.05);
  assert.equal(exact.state,'running');
  exact.update(.05); assert.equal(exact.result.reason,'stumble');
});

check('skill: continuous taps and advance lane choices finish at 20/30/60 FPS', () => {
  metrics.skillControllers=[];
  for(const dt of [.05,1/30,1/60]){
    let finishes=0;
    for(let seed=1;seed<=35;seed++){
      const engine=running({random:seeded(seed)});
      const result=drive(engine,{dt,tapEvery:2,dodge:true});
      if(result.reason==='finish')finishes++;
    }
    metrics.skillControllers.push({fps:Math.round(1/dt),finishes,rounds:35});
    assert.equal(finishes,35,`safe controller finished ${finishes}/35 at ${Math.round(1/dt)} FPS`);
  }
});

check('pause and checkpoint resume freeze time and grant a fresh input grace', () => {
  const engine=isolate(running());
  for(let i=0;i<40;i++){engine.tap();engine.update(.05);}
  engine.pause();const before={distance:engine.distance,time:engine.time};
  for(let i=0;i<500;i++)engine.update(.05);
  assert.deepEqual({distance:engine.distance,time:engine.time},before);
  engine.resume();assert.equal(engine.inputGraceUntil,engine.time+1);assert.equal(engine.taps.length,0);
  for(let i=0;i<19;i++)engine.update(.05);
  assert.equal(engine.state,'running');engine.tap();
  engine.distance=199.8;engine.speed=30;engine.update(.05);
  assert.equal(engine.state,'checkpoint');assert.equal(engine.distance,200);
  const checkpointTime=engine.time;engine.update(30);assert.equal(engine.time,checkpointTime);
  engine.continue();assert.equal(engine.inputGraceUntil,engine.time+1);assert.equal(engine.floor,2);
  for(let i=0;i<19;i++)engine.update(.05);
  assert.equal(engine.state,'running');
});

check('probability: early hard collision is nonlethal; inactivity stumbles and resumes', () => {
  const events=[];
  const engine=isolate(running({mode:'probability',random:ticketRandom(.999,.999),onEvent:(name,payload)=>events.push({name,payload})}));
  const target={...engine.outcome};engine.distance=50;engine.speed=30;engine.obstacles=[hazard('btc')];engine.tap();engine.update(.05);
  assert.equal(engine.state,'running');assert(engine.obstacles[0].passed);assert(engine.effect);assert(engine.slowRemaining>0);
  assert.deepEqual(engine.outcome,target);
  for(let i=0;i<90;i++)engine.update(.05);
  assert.equal(engine.state,'running');assert.equal(engine.stumbled,true);assert.equal(engine.speed,0);
  assert(events.some(event=>event.name==='impact'));assert(events.some(event=>event.name==='stumble'));
  engine.tap();assert.equal(engine.stumbled,false);assert(events.some(event=>event.name==='recover'));
  engine.update(.05);assert(engine.speed>0);assert.deepEqual(engine.outcome,target);
});

check('probability: same seeded outcome is unchanged by different input and lane choices', () => {
  for(const ticket of [.1,.7,.8,.95,.999]){
    const aggressive=running({mode:'probability',random:ticketRandom(ticket,.8,85)});
    const measured=running({mode:'probability',random:ticketRandom(ticket,.8,85)});
    assert.deepEqual(aggressive.outcome,measured.outcome);
    const target={...aggressive.outcome};
    const a=drive(aggressive,{tapEvery:1,dodge:true}),b=drive(measured,{tapEvery:3,dodge:false});
    assert.equal(a.distance,target.distance);assert.equal(b.distance,target.distance);
    assert.equal(a.multiplier,target.multiplier);assert.equal(b.multiplier,target.multiplier);
  }
});

check('probability: 1,200 completed games exactly match chooseOutcome including all five bands', () => {
  const bands={loss:0,breakEven:0,smallWin:0,double:0,highWin:0};
  let ended=0;
  for(let round=0;round<1200;round++){
    const seed=Math.imul(9200+round,2654435761)>>>0;
    const expected=chooseOutcome(seeded(seed),DEFAULT_RULES);
    const engine=running({mode:'probability',random:seeded(seed),onEvent:name=>{if(name==='end')ended++;}});
    assert.deepEqual(engine.outcome,expected);
    const result=drive(engine,{tapEvery:2,dodge:round%2===0});
    assert.equal(result.distance,expected.distance);assert.equal(result.multiplier,expected.multiplier);
    assert.equal(result.template,expected.key);bands[expected.key]++;
    engine.end('finish');engine.take();
  }
  assert.equal(ended,1200);for(const count of Object.values(bands))assert(count>0);
  metrics.completedProbabilityGames={rounds:1200,bands};
});

check('probability: a 200 m template presents checkpoint before take or continue', () => {
  for(const action of ['take','continue']){
    const events=[];
    const engine=running({mode:'probability',random:ticketRandom(.95),onEvent:name=>events.push(name)});
    for(let frame=0;frame<6000&&engine.state==='running';frame++){engine.tap();engine.update(.05);}
    assert.equal(engine.state,'checkpoint','200m scheduled collision bypassed checkpoint');
    assert.equal(engine.distance,200);assert(events.includes('checkpoint'));assert(!events.includes('end'));
    engine[action]();
    if(action==='continue')drive(engine);
    assert.equal(engine.result.multiplier,2);assert.equal(engine.result.payout,20);
  }
});

check('soft slow and weather hazards do not kill either mode and emit visual impacts', () => {
  const softHazards=OBSTACLES.filter(obstacle=>['slow','weather'].includes(obstacle.behavior));
  assert(softHazards.some(obstacle=>obstacle.behavior==='slow'));assert(softHazards.some(obstacle=>obstacle.behavior==='weather'));
  for(const mode of ['skill','probability'])for(const obstacle of softHazards){
    const id=obstacle.id;
    const events=[];
    const engine=isolate(running({mode,random:ticketRandom(.999,.999),onEvent:name=>events.push(name)}));
    engine.distance=120;engine.speed=30;engine.obstacles=[hazard(id)];engine.tap();engine.update(.05);
    assert.equal(engine.state,'running');assert(engine.obstacles[0].passed);assert(engine.effect);assert.equal(engine.effect.obstacle,id);
    assert(events.includes('impact'));assert(engine.slowRemaining>0);
    if(obstacle.behavior==='weather'){assert(engine.weather);assert(events.includes('weather'));}
    const elapsed=engine.effect.elapsed;engine.tap();engine.update(.05);assert(engine.effect.elapsed>elapsed);
  }
});

check('snapshot restore preserves probability target and immutable per-game rules', () => {
  const rules=normalizeRules({...DEFAULT_RULES,mode:'probability',tapTimeout:.3});
  const engine=running({rules,mode:'probability',random:ticketRandom(.999,.8)});
  for(let frame=0;frame<60;frame++){engine.tap();engine.update(.05);}
  const saved=engine.snapshot();const target={...engine.outcome};
  const restored=new RunnerEngine({random:seeded(777)});assert.equal(restored.restore(saved),true);
  assert.equal(restored.state,'paused');assert.deepEqual(restored.outcome,target);assert.deepEqual(restored.rules,rules);
  assert(Object.isFrozen(restored.rules));assert.equal(restored.configure(DEFAULT_RULES),false);
  saved.rules.tapTimeout=1;saved.outcome.distance=20;assert.equal(restored.rules.tapTimeout,.3);assert.deepEqual(restored.outcome,target);
  restored.resume();const result=drive(restored,{tapEvery:3});assert.equal(result.distance,target.distance);assert.equal(result.multiplier,target.multiplier);
});

check('snapshot restore rejects corrupt core state and inconsistent template metadata', () => {
  const source=running({mode:'probability',random:ticketRandom(.999,.8)}).snapshot();
  const corruptions=[
    ['version',state=>state.version=2],['state',state=>state.state='ended'],['stake',state=>state.stake=0],
    ['distance',state=>state.distance=-1],['time',state=>state.time=Infinity],['lane',state=>state.lane=4],
    ['rules',state=>state.rules.lossWeight=61],['outcome below current',state=>{state.distance=200;state.outcome.distance=100;}],
    ['outcome multiplier',state=>state.outcome.multiplier=0],['unknown obstacle',state=>state.obstacles=[hazard('btc',1,20,{id:'unknown'})]],
    ['energy',state=>state.energy=NaN],['safe lane',state=>state.safeLane=17],
    ['countdown',state=>state.countdown='invalid'],['template key',state=>state.outcome.key='forged'],
    ['checkpoint flag',state=>state.checkpoint='false'],['protected flag',state=>state.protectedRound='false'],
    ['paused resume state',state=>{state.state='paused';state.resumeState='invalid';}],
  ];
  const accepted=[];
  for(const [name,corrupt]of corruptions){const state=structuredClone(source);corrupt(state);if(new RunnerEngine().restore(state))accepted.push(name);}
  assert.deepEqual(accepted,[],`corrupt snapshots accepted: ${accepted.join(', ')}`);
});

check('same-frame earliest collision prevents crossing 100/200/500 m reward lines', () => {
  for(const [distance,multiplier]of[[99.8,0],[199.8,1.9],[499.8,4.9]]){
    for(const reverse of [false,true]){
      const engine=isolate(running());engine.distance=distance;engine.speed=33;engine.checkpoint=distance>200;
      const blockers=[hazard('btc',1,1.6),hazard('eth',1,2.5)];engine.obstacles=reverse?blockers.reverse():blockers;
      engine.tap();engine.update(.05);assert.equal(engine.result.reason,'collision');assert.equal(engine.result.multiplier,multiplier);
      assert.equal(engine.result.obstacle,hazard('btc').name);assert(engine.distance<Math.ceil(distance));
      assert.equal(engine.result.multiplier,multiplierForDistance(engine.distance,engine.rules));
    }
  }
  const boundary=isolate(running());boundary.distance=199.8;boundary.speed=33;boundary.obstacles=[hazard('btc',1,2)];boundary.tap();boundary.update(.05);
  assert.equal(boundary.state,'checkpoint');assert.equal(boundary.distance,200);
  assert(Math.abs(boundary.obstacles[0].ahead-1.8)<1e-8);
});

const report={ok:failures.length===0,passed:checks.length,failed:failures.length,checks,failures,metrics};
console.log(JSON.stringify(report,null,2));
await fs.writeFile(new URL('./v3-engine-results.json',import.meta.url),JSON.stringify(report,null,2));
if(failures.length)process.exitCode=1;
