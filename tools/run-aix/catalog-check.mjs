import assert from 'node:assert/strict';
import { HAZARDS } from '../../resources/app/public/games/run-aix/hazards.js';
import { DEFAULT_CATALOG, CATALOG_STORAGE_KEY, getDefaults, validateCatalog, loadCatalog, saveCatalog, resetCatalog, rollbackCatalog, loadCatalogHistory } from '../../resources/app/public/games/run-aix/catalog.js';

const checks=[];
const check=(name,test)=>{test();checks.push(name);};
const memory=()=>{const values=new Map();return{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};};
check('defaults reflect runtime HAZARDS with deeply frozen per-round data',()=>{
  assert.deepEqual(Object.keys(DEFAULT_CATALOG),HAZARDS.map(hazard=>hazard.id));
  for(const hazard of HAZARDS){
    const value=DEFAULT_CATALOG[hazard.id];assert.equal(value.line,hazard.line);assert.equal(value.behavior,hazard.behavior);
    assert(Object.isFrozen(value));assert(Object.isFrozen(value.lanes));assert(Object.isFrozen(value.scenes));
  }
  assert(Object.isFrozen(DEFAULT_CATALOG));assert.deepEqual(getDefaults(),DEFAULT_CATALOG);
  assert.throws(()=>DEFAULT_CATALOG.btc.lanes.push(8));
});
check('partial edits merge defaults without mutating input; weight and scene are independent',()=>{
  const input={btc:{weight:4,lanes:[2,0],scenes:[2],line:'自定义受击台词'}};
  const result=validateCatalog(input);assert.equal(result.btc.weight,4);assert.deepEqual(result.btc.lanes,[0,2]);
  assert.deepEqual(input.btc.lanes,[2,0]);assert.deepEqual(result.eth,DEFAULT_CATALOG.eth);
  assert.equal(result.btc.line,'自定义受击台词');assert.equal(result.btc.behavior,'block');
});
check('unknown ids, keys, bounds, wrong types and invalid subsets are rejected',()=>{
  for(const input of [null,[],new Date(),{unknown:{}},{btc:null},{btc:{enabled:1}},{btc:{weight:'1'}},{btc:{weight:NaN}},{btc:{weight:101}},
    {btc:{minDistance:-1}},{btc:{minDistance:0.5}},{btc:{minDistance:2001}},{btc:{behavior:'hidden'}},
    {btc:{lanes:[]}},{btc:{lanes:[0,0]}},{btc:{lanes:[3]}},{btc:{scenes:[]}},{btc:{scenes:['1']}},
    {btc:{line:'a'.repeat(201)}},{btc:{line:1}},{btc:{evil:true}},JSON.parse('{"__proto__":{}}')])assert.throws(()=>validateCatalog(input));
});
check('an effective zero-distance starter exists for every scene; disabling all is rejected',()=>{
  const none=structuredClone(getDefaults());for(const value of Object.values(none))value.enabled=false;
  assert.throws(()=>validateCatalog(none),/至少/);
  const late=structuredClone(getDefaults());for(const value of Object.values(late))value.minDistance=1;
  assert.throws(()=>validateCatalog(late),/至少/);
  const emptyScene=structuredClone(getDefaults());for(const value of Object.values(emptyScene))value.scenes=[0,1];
  assert.throws(()=>validateCatalog(emptyScene),/场景 3/);
  const one=structuredClone(none);one.btc.enabled=true;one.btc.weight=1;assert(validateCatalog(one));
});
check('versioned saving, capped history, rollback, reset and corruption fallback work',()=>{
  const local=memory();assert.deepEqual(loadCatalog(local),DEFAULT_CATALOG);
  const saved=saveCatalog({btc:{weight:5}},local);assert.equal(saved.revision,1);assert.equal(loadCatalog(local).btc.weight,5);
  saveCatalog({btc:{weight:8}},local);const rolled=rollbackCatalog(1,local);assert.equal(rolled.revision,3);assert.equal(loadCatalog(local).btc.weight,5);
  assert.equal(resetCatalog(local).revision,4);assert.deepEqual(loadCatalog(local),DEFAULT_CATALOG);
  assert.deepEqual(loadCatalogHistory(local).map(item=>item.revision),[4,3,2,1]);
  for(let i=0;i<35;i++)saveCatalog(DEFAULT_CATALOG,local);assert.equal(loadCatalogHistory(local).length,30);
  assert.throws(()=>rollbackCatalog(1,local));local.setItem(CATALOG_STORAGE_KEY,'{bad');assert.deepEqual(loadCatalog(local),DEFAULT_CATALOG);
  assert.throws(()=>saveCatalog(DEFAULT_CATALOG,{getItem:()=>null,setItem:()=>{throw Error('quota');}}),/保存失败/);
});
console.log(JSON.stringify({ok:true,passed:checks.length,checks,catalogSize:HAZARDS.length},null,2));
