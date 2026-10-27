import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { RunnerEngine as CoreRunnerEngine } from '../../resources/app/public/games/run-aix/engine.js';
// Preserve physical-road regressions under the explicit no-input-constraint option.
// The V3 defaults and probability mode are exercised by v3-engine-check.mjs.
class RunnerEngine extends CoreRunnerEngine {
  constructor(options = {}) { super({ ...options, rules: { mode: 'skill', continuousTapRequired: false, ...options.rules } }); }
}
import { CONFIG, multiplier, payout } from '../../resources/app/public/games/run-aix/config.js';
import { PracticeStore } from '../../resources/app/public/games/run-aix/store.js';
import { difficultyAt, targetSpeed, obstacleRow } from '../../resources/app/public/games/run-aix/difficulty.js';
const checks = [];
const metrics = {};
const check = (name, fn) => { fn(); checks.push(name); };
check('倍率边界和取整：100/110/200/500', () => {
  for (const [distance, expected] of [[0, 0], [99.999, 0], [100, 1], [109.99, 1], [110, 1.1], [199.9, 1.9], [200, 2], [220, 2.2], [499.9, 4.9], [500, 5], [600, 5], [NaN, 0]]) assert.equal(multiplier(distance), expected);
  assert.equal(payout(3, 110), 3.3);
});
function running() {
  const engine = new RunnerEngine({ random: () => 0 }); assert.ok(engine.start(10));
  for (let i = 0; i < 61; i++) engine.update(0.05);
  assert.equal(engine.state, 'running'); engine.nextSpawnDistance = Infinity; return engine;
}
check('倒计时与对局启动不重复', () => { const e = running(); assert.equal(e.start(10), false); assert.equal(e.start(-1), false); });
check('换道边界与单帧大时间钳制', () => { const e = running(); e.move(-1); e.move(-1); assert.equal(e.lane, 0); e.move(1); e.move(1); e.move(1); assert.equal(e.lane, 2); e.update(30); assert.ok(e.distance < 2); });
check('碰撞全损与安全车道可躲避', () => {
  const e = running(); e.obstacles = [{ lane: 1, ahead: 1, passed: false }]; e.update(0.05); assert.equal(e.state, 'ended'); assert.equal(e.result.payout, 0);
  const safe = running(); safe.obstacles = [{ lane: 0, ahead: 1, passed: false }]; safe.update(0.05); assert.equal(safe.state, 'running');
});
check('200 米检查点，继续后锁底，碰撞仍有两倍', () => {
  const e = running(); e.distance = 199.8; e.speed = 20; e.update(0.05); assert.equal(e.distance, 200); assert.equal(e.state, 'checkpoint');
  e.continue(); assert.equal(e.floor, 2); e.obstacles = [{ lane: 1, ahead: 1, passed: false }]; e.update(0.05); assert.equal(e.result.payout, 20);
});
check('主动收取与500米封顶', () => { const e = running(); e.distance = 150; e.take(); assert.equal(e.result.payout, 15); const cap = running(); cap.distance = 499.9; cap.speed = 20; cap.checkpoint = true; cap.update(0.05); assert.equal(cap.result.multiplier, 5); assert.equal(cap.result.payout, 50); });
check('暂停不前进、恢复清空连点队列', () => { const e = running(); e.tap(); e.pause(); const distance = e.distance; e.update(0.05); assert.equal(e.distance, distance); e.resume(); assert.equal(e.taps.length, 0); });
check('连续点击额外冲刺，停止后回到当前距离的基础速度', () => { const e = running(); for (let i = 0; i < 22; i++) { e.tap(); e.update(0.05); } assert.ok(e.speed > targetSpeed(e.distance, 0) + 10); const boosted = e.speed; for (let i = 0; i < 50; i++) e.update(0.05); assert.ok(e.speed < boosted); assert.ok(Math.abs(e.speed - targetSpeed(e.distance, 0)) < .5); });
check('关闭断连约束时基础速度随距离加速，后程不会退回开局速度', () => {
  const distances=[0,100,200,350,500];const speeds=distances.map(d=>targetSpeed(d,0));
  assert.equal(speeds[0],18);assert.equal(speeds.at(-1),42);
  for(let i=1;i<speeds.length;i++)assert.ok(speeds[i]>speeds[i-1]);
  for(const d of distances)assert.ok(targetSpeed(d,7)>targetSpeed(d,0));
  assert.equal(targetSpeed(500,7),56);
  const e=running();e.distance=350;e.checkpoint=true;
  for(let i=0;i<50;i++)e.update(.05);assert.ok(e.speed>35);
});
check('后程双车道障碍与主动换道显著增加，安全路线始终相邻可达', () => {
  assert.ok(difficultyAt(450).rowSpacing < difficultyAt(0).rowSpacing);
  let seed=14,lastSafe=1,doubles=0,changes=0;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32};
  for(let i=0;i<3000;i++){
    const row=obstacleRow(random,450,lastSafe);
    assert.ok(row.obstacles.length>=1&&row.obstacles.length<=2);
    assert.ok(!row.obstacles.some(o=>o.lane===row.safeLane));
    assert.ok(Math.abs(row.safeLane-lastSafe)<=1);
    if(row.safeLane!==lastSafe){
      changes++;
      assert.ok(row.obstacles.some(o=>o.lane===lastSafe),'A requested lane change must block the old safe lane');
    }
    lastSafe=row.safeLane;
    if(row.obstacles.length===2)doubles++;
  }
  assert.ok(doubles>2600&&doubles<2950,`late double rows: ${doubles}/3000`);
  assert.ok(changes>2600,`late safe-lane changes: ${changes}/3000`);
});
check('随机实际障碍下提前换道可通关，停在同一车道不能稳定通关', () => {
  let seed=37;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32};
  let activeWins=0,idleWins=0,idleDistance=0;
  const activeByFrameRate=[];
  for(const {active,dt} of [{active:true,dt:.05},{active:true,dt:1/30},{active:true,dt:1/60},{active:false,dt:.05}]){
    let wins=0;
    for(let round=0;round<100;round++){
    const e=new RunnerEngine({random});e.start(10);
    for(let frame=0;frame<4000&&e.state!=='ended';frame++){
      if(e.state==='checkpoint')e.continue();
      if(active&&e.state==='running'){
        if(frame%2===0)e.tap();
        const upcoming=e.obstacles.filter(o=>!o.passed&&o.ahead>1.5).sort((a,b)=>a.ahead-b.ahead);
        if(upcoming[0]?.ahead<18){
          const blocked=upcoming.filter(o=>Math.abs(o.ahead-upcoming[0].ahead)<.01).map(o=>o.lane);
          if(blocked.includes(e.lane)){
            const safe=[0,1,2].filter(lane=>!blocked.includes(lane)).sort((a,b)=>Math.abs(a-e.lane)-Math.abs(b-e.lane))[0];
            e.move(Math.sign(safe-e.lane));
          }
        }
      }
      e.update(dt);
    }
      assert.equal(e.state,'ended');
      if(e.result?.reason==='finish'){wins++;active?activeWins++:idleWins++;}
      if(!active)idleDistance+=e.result.distance;
    }
    if(active)activeByFrameRate.push({fps:Math.round(1/dt),wins,runs:100});
  }
  assert.equal(activeWins,300,'18m warning must leave a feasible path at sprint speed across 20/30/60 FPS');
  assert.ok(idleWins<10,'Standing still must not be the winning strategy');
  metrics.sprintController={warningMetres:18,results:activeByFrameRate};
  metrics.idle={runs:100,finishes:idleWins,meanDistance:Math.round(idleDistance)/100};
});
function sampleRoad({ boost, deltas = [.05], seed = 91 }) {
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32};
  const e=new RunnerEngine({random});e.start(10);
  const seen=new WeakSet(),positions=[],counts=[];let checkpoints=0;
  for(let frame=0;frame<8000&&e.state!=='ended';frame++){
    if(e.state==='checkpoint'){
      checkpoints++;
      const snapshot={distance:e.distance,spawn:e.nextSpawnDistance,count:e.obstacles.length};
      for(let i=0;i<20;i++)e.update(deltas[i%deltas.length]);
      assert.deepEqual({distance:e.distance,spawn:e.nextSpawnDistance,count:e.obstacles.length},snapshot);
      e.continue();
      assert.equal(e.nextSpawnDistance,snapshot.spawn,'Checkpoint continuation must retain the next row position');
    }
    if(boost)e.tap();
    e.update(deltas[frame%deltas.length]);
    for(const o of e.obstacles){
      if(!seen.has(o)){
        seen.add(o);
        const position=e.distance+o.ahead;
        let row=positions.findIndex(p=>Math.abs(p-position)<1e-7);
        if(row<0){row=positions.length;positions.push(position);counts.push(0);}
        counts[row]++;
      }
      // Isolate road scheduling from collisions while retaining the real speed and checkpoint logic.
      o.passed=true;
    }
  }
  assert.equal(e.result?.reason,'finish');assert.equal(checkpoints,1);
  return {positions,doubleRows:counts.filter(count=>count===2).length,
    reachedRows:positions.filter(p=>p<=CONFIG.maxDistance+1.5).length,
    reachedDoubleRows:counts.filter((count,i)=>count===2&&positions[i]<=CONFIG.maxDistance+1.5).length};
}
check('巡航与全速保持相近空间密度，障碍间距明显低于旧版全速35.2米下限', () => {
  const cruise=sampleRoad({boost:false}).positions,sprintRoad=sampleRoad({boost:true}),sprint=sprintRoad.positions;
  const average=rows=>(rows.at(-1)-rows[0])/(rows.length-1);
  assert.ok(cruise.length>=21&&sprint.length>=21,`${cruise.length}/${sprint.length} rows`);
  assert.ok(Math.abs(cruise.length-sprint.length)<=1);
  assert.ok(Math.abs(average(cruise)-average(sprint))<1);
  assert.ok(average(sprint)<35.2*.7,`mean sprint spacing ${average(sprint)}m`);
  assert.ok(Math.abs(cruise[0]-64)<1e-7&&Math.abs(sprint[0]-64)<1e-7,'The first row appears at 8m with a 56m lead');
  metrics.road={seed:91,cruiseRows:cruise.length,sprintRows:sprint.length,sprintDoubleRows:sprintRoad.doubleRows,
    sprintDoublePercent:Math.round(sprintRoad.doubleRows/sprint.length*1000)/10,
    reachedRows:sprintRoad.reachedRows,reachedDoubleRows:sprintRoad.reachedDoubleRows,
    meanSpacing:Math.round(average(sprint)*100)/100,
    minSpacing:Math.round(Math.min(...sprint.slice(1).map((p,i)=>p-sprint[i]))*100)/100};
});
check('低帧率与检查点继续不堆叠障碍，同帧越过生成点仍补偿到正确空间位置', () => {
  for(const deltas of [[1/60],[1/30],[1/15],[.016,.25,.033]]){
    const rows=sampleRoad({boost:true,deltas}).positions;
    for(let i=1;i<rows.length;i++){
      const gap=rows[i]-rows[i-1];
      assert.ok(gap>=17-1e-7&&gap<=26+1e-7,`invalid row gap ${gap}m at ${deltas}`);
    }
    const aroundCheckpoint=rows.filter(position=>Math.abs(position-256)<30);
    assert.ok(aroundCheckpoint.length>=2,'The road remains populated across the checkpoint');
  }
});
check('试玩账本只扣一次、结算幂等、保存可恢复', () => {
  const memory = new Map(); const storage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) };
  const store = new PracticeStore(storage); assert.equal(store.spend(10), true); assert.equal(store.data.credits, 990); assert.equal(store.spend(101), false);
  const record = { id: 'test', payout: 20, date: Date.now(), distance: 200, multiplier: 2 };
  assert.equal(store.settle(record), true); assert.equal(store.settle(record), false); assert.equal(store.data.credits, 1010); assert.equal(new PracticeStore(storage).data.credits, 1010);
});
check('同一帧内先撞击再跨线，100/200/500米不能错误返奖', () => {
  for (const [distance, expected] of [[99.8, 0], [199.8, 1.9], [499.8, 4.9]]) {
    const e = running(); e.distance = distance; e.speed = 33; e.checkpoint = distance > 200;
    e.obstacles = [{ lane: 1, ahead: 1.6, passed: false }]; e.update(0.05);
    assert.equal(e.state, 'ended'); assert.equal(e.result.reason, 'collision'); assert.equal(e.result.multiplier, expected);
  }
  const e = running(); e.distance = 199.8; e.speed = 33; e.obstacles = [{ lane: 1, ahead: 2, passed: false }];
  e.update(0.05); assert.equal(e.state, 'checkpoint'); assert.ok(Math.abs(e.obstacles[0].ahead - 1.8) < 1e-8);
});
check('无效帧时间不破坏状态', () => { const e = running(); const before = e.distance; e.update(NaN); e.update(Infinity); e.update(-1); assert.equal(e.distance, before); });
check('1000局随机操作压力测试：一次结算、边界与返还一致', () => {
  let seed = 73; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let round = 0; round < 1000; round++) {
    let ended = 0; const e = new RunnerEngine({ random, onEvent: name => { if (name === 'end') ended++; } });
    const stake = 1 + Math.floor(random() * 100); e.start(stake);
    for (let frame = 0; frame < 5000 && e.state !== 'ended'; frame++) {
      if (e.state === 'checkpoint') { random() < 0.4 ? e.take() : e.continue(); }
      if (random() < 0.6) e.tap(); if (random() < 0.12) e.move(random() < 0.5 ? -1 : 1);
      if (random() < 0.01) { e.pause(); e.resume(); }
      e.update(0.05);
      assert.ok(e.distance >= 0 && e.distance <= 500); assert.ok(e.lane >= 0 && e.lane <= 2);
    }
    assert.equal(e.state, 'ended'); assert.equal(ended, 1); assert.ok(e.result.payout >= 0 && e.result.payout <= stake * 5);
    e.take(); e.end('finish'); assert.equal(ended, 1);
  }
});
console.log(JSON.stringify({ passed: checks.length, checks, metrics }, null, 2));
await fs.writeFile(new URL('./engine-results.json', import.meta.url), JSON.stringify({ passed: checks.length, checks, simulatedRounds: 1000, metrics }, null, 2));
export { checks };
