import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { DEFAULT_RULES, normalizeRules } from '../../resources/app/public/games/run-aix/rules.js';
import { getDefaults, validateCatalog, saveCatalog, loadCatalog } from '../../resources/app/public/games/run-aix/catalog.js';
import { obstacleRow } from '../../resources/app/public/games/run-aix/difficulty.js';
import { RunnerEngine } from '../../resources/app/public/games/run-aix/engine.js';

const checks=[],metrics={};
const check=(name,test)=>{test();checks.push(name);};
const seeded=initial=>{let seed=initial>>>0;return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};};
const rules=normalizeRules({...DEFAULT_RULES,mode:'skill',doubleChanceStart:1,doubleChanceEnd:1,changeChanceStart:0,changeChanceEnd:0});
function only(ids){const catalog=structuredClone(getDefaults());for(const[id,value]of Object.entries(catalog))value.enabled=ids.includes(id);return catalog;}

check('disabled and zero-weight entries never spawn; configured behavior and line do spawn',()=>{
  const draft=only(['btc','eth','bnb']);draft.btc.weight=0;draft.eth.line='本机自定义受击';draft.eth.behavior='weather';draft.bnb.enabled=false;
  const catalog=validateCatalog(draft),random=seeded(24);
  for(let row=0;row<1000;row++)for(const obstacle of obstacleRow(random,0,1,rules,catalog).obstacles){assert.equal(obstacle.id,'eth');assert.equal(obstacle.line,'本机自定义受击');assert.equal(obstacle.behavior,'weather');}
});

check('relative weighted selection follows configured 1:9 frequency over 20,000 obstacles',()=>{
  const draft=only(['btc','eth']);draft.btc.weight=1;draft.eth.weight=9;const catalog=validateCatalog(draft),random=seeded(176);
  const counts={btc:0,eth:0};for(let row=0;row<10000;row++)for(const obstacle of obstacleRow(random,80,1,rules,catalog).obstacles)counts[obstacle.id]++;
  const btcPercent=counts.btc/(counts.btc+counts.eth)*100;assert(Math.abs(btcPercent-10)<1,`BTC ${btcPercent}%`);metrics.weighted={...counts,btcPercent};
});

check('minimum spawn metres and scene membership are respected at boundary distances',()=>{
  const draft=only(['btc','eth','bnb']);
  draft.btc.scenes=[0];draft.eth.scenes=[1];draft.bnb.scenes=[2];
  draft.ghost={...draft.ghost,enabled:true,weight:100,minDistance:50,scenes:[0]};
  const catalog=validateCatalog(draft),random=seeded(73);
  for(const[distance,allowed]of[[0,['btc']],[49,['btc']],[50,['btc','ghost']],[166,['btc','ghost']],[167,['eth']],[333,['eth']],[334,['bnb']],[500,['bnb']]]){
    const seen=new Set();for(let row=0;row<200;row++)for(const obstacle of obstacleRow(random,distance,1,rules,catalog).obstacles){assert(allowed.includes(obstacle.id),`unexpected ${obstacle.id} at ${distance}m`);seen.add(obstacle.id);}
    for(const id of allowed)assert(seen.has(id),`expected ${id} at ${distance}m`);
  }
});

check('allowed lanes never occupy a safe lane; unmatched slots are safely skipped',()=>{
  const draft=only(['btc','eth','bnb']);draft.btc.lanes=[0];draft.eth.lanes=[1];draft.bnb.lanes=[2];const catalog=validateCatalog(draft),random=seeded(59);
  for(let previousSafe=0;previousSafe<=2;previousSafe++)for(let row=0;row<100;row++){
    const result=obstacleRow(random,40,previousSafe,rules,catalog);assert.equal(result.safeLane,previousSafe);assert.equal(result.obstacles.length,2);
    for(const obstacle of result.obstacles){assert.notEqual(obstacle.lane,result.safeLane);assert(catalog[obstacle.id].lanes.includes(obstacle.lane));assert.equal(obstacle.id,['btc','eth','bnb'][obstacle.lane]);}
  }
  const one=only(['btc']);one.btc.lanes=[1];const sparse=validateCatalog(one);
  const result=obstacleRow(random,0,1,rules,sparse);assert.equal(result.safeLane,1);assert.deepEqual(result.obstacles,[]);
});

check('in-flight engine and restored snapshot preserve old catalog; configure before new round reads saved changes',()=>{
  const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  const oldGlobal=Object.getOwnPropertyDescriptor(globalThis,'localStorage');Object.defineProperty(globalThis,'localStorage',{configurable:true,value:storage});
  try{
    const old=only(['btc']);old.btc.line='旧库台词';saveCatalog(old,storage);
    const engine=new RunnerEngine({rules,random:seeded(16)});assert(engine.start(10));
    for(let frame=0;frame<62&&engine.state==='countdown';frame++)engine.update(.05);
    for(let frame=0;frame<20;frame++){engine.tap();engine.update(.05);}
    assert(engine.obstacles.length);assert(engine.obstacles.every(obstacle=>obstacle.id==='btc'));const saved=engine.snapshot();
    const next=only(['eth']);next.eth.line='新库台词';saveCatalog(next,storage);assert.equal(loadCatalog(storage).btc.enabled,false);
    assert.equal(engine.configure(rules),false);assert.equal(engine.catalog.btc.enabled,true);assert.equal(engine.catalog.btc.line,'旧库台词');
    assert(Object.isFrozen(engine.catalog));assert(Object.isFrozen(engine.catalog.btc.lanes));
    const restored=new RunnerEngine({rules,random:seeded(17)});assert.equal(restored.catalog.eth.enabled,true);assert(restored.restore(saved));
    assert.equal(restored.catalog.btc.enabled,true);assert.equal(restored.catalog.eth.enabled,false);assert.equal(restored.catalog.btc.line,'旧库台词');
    assert(restored.obstacles.every(obstacle=>obstacle.id==='btc'&&obstacle.line==='旧库台词'));assert.equal(restored.state,'paused');
    saved.catalog.btc.line='外部污染';assert.equal(restored.catalog.btc.line,'旧库台词');
    const corrupt=engine.snapshot();corrupt.catalog.btc.weight=-1;assert.equal(new RunnerEngine({rules}).restore(corrupt),false);
    engine.end('take');assert(engine.configure(rules));assert.equal(engine.catalog.btc.enabled,false);assert.equal(engine.catalog.eth.enabled,true);assert(engine.start(10));
    for(let frame=0;frame<62&&engine.state==='countdown';frame++)engine.update(.05);
    for(let frame=0;frame<20;frame++){engine.tap();engine.update(.05);}
    assert(engine.obstacles.length);assert(engine.obstacles.every(obstacle=>obstacle.id==='eth'&&obstacle.line==='新库台词'));
  }finally{if(oldGlobal)Object.defineProperty(globalThis,'localStorage',oldGlobal);else delete globalThis.localStorage;}
});
const report={ok:true,passed:checks.length,checks,metrics};console.log(JSON.stringify(report,null,2));
await fs.writeFile(new URL('./catalog-integration-results.json',import.meta.url),JSON.stringify(report,null,2));
