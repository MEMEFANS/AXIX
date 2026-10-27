import assert from 'node:assert/strict';
import {
  DEFAULT_RULES, RULES_STORAGE_KEY, normalizeRules, multiplierForDistance, payoutForDistance,
  chooseOutcome, simulateRules, loadRules, saveRules, resetRules, rollbackRules, loadRulesHistory,
} from '../../resources/app/public/games/run-aix/rules.js';

const cases = [];
function check(name, fn) { fn(); cases.push(name); }
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
};
const drawAt = (weight, distance) => { const sequence = [weight, distance]; return () => sequence.shift(); };

check('default rules are frozen and valid', () => {
  assert(Object.isFrozen(DEFAULT_RULES)); assert.deepEqual(normalizeRules(), DEFAULT_RULES);
  assert.equal(DEFAULT_RULES.lossWeight + DEFAULT_RULES.breakEvenWeight + DEFAULT_RULES.smallWinWeight + DEFAULT_RULES.doubleWeight + DEFAULT_RULES.highWinWeight, 100);
});
check('all payout boundaries use the documented 10 m curve', () => {
  for (const [distance, expected] of [[0,0],[99.999,0],[100,1],[109.999,1],[110,1.1],[190,1.9],[199,1.9],[200,2],[209,2],[210,2.1],[220,2.2],[499,4.9],[500,5],[900,5]]) assert.equal(multiplierForDistance(distance), expected);
  assert.equal(payoutForDistance(7, 170), 11.9);
});
check('strict validation rejects invalid values and inconsistent curves', () => {
  for (const changes of [null, [], {mode:'hidden'}, {minStake:'1'}, {maxStake:NaN}, {unknown:1}, {continuousTapRequired:1}, {lossWeight:61}, {burnPercent:50}, {breakevenDistance:110}, {maxDistance:490}, {rowSpacingEnd:30}, {rocketSpeed:15}, {warningDistance:30}, {lotteryCost:0}, {dailyRoundLimit:1.5}]) assert.throws(() => normalizeRules(changes));
  assert.throws(() => normalizeRules(JSON.parse('{"__proto__":{}}')));
  const custom = normalizeRules({ breakevenDistance:80, checkpointDistance:160, maxDistance:400, stepDistance:8 });
  assert.equal(multiplierForDistance(168, custom), 2.1);
});
check('outcome ticket boundaries and distance ranges follow all five bands', () => {
  for (const [ticket, expected] of [[0,'loss'],[0.599999,'loss'],[0.6,'breakEven'],[0.749999,'breakEven'],[0.75,'smallWin'],[0.929999,'smallWin'],[0.93,'double'],[0.989999,'double'],[0.99,'highWin'],[0.999999,'highWin']]) assert.equal(chooseOutcome(drawAt(ticket,0)).key, expected);
  for (const [ticket, low, high] of [[0,20,99],[0.6,100,109],[0.75,110,190],[0.93,200,200],[0.99,210,500]]) {
    assert.equal(chooseOutcome(drawAt(ticket,0)).distance, low);
    assert.equal(chooseOutcome(drawAt(ticket,0.999999)).distance, high);
  }
  assert.equal(chooseOutcome(drawAt(0.99, 1/30)).distance, 220);
  assert.equal(chooseOutcome(drawAt(0.99, 1/30)).multiplier, 2.2);
  assert.throws(() => chooseOutcome(() => 1)); assert.throws(() => chooseOutcome(() => -1));
});
check('saving, history, reset and rollback preserve versioned rules', () => {
  const local = storage();
  assert.deepEqual(loadRules(local), DEFAULT_RULES);
  const first = saveRules({ mode:'skill' }, local); assert.equal(first.revision, 1); assert.equal(loadRules(local).mode,'skill');
  const second = saveRules({ ...first.rules, tapTimeout:0.3 },local); assert.equal(second.revision,2);
  assert.equal(rollbackRules(1,local).revision,3); assert.equal(loadRules(local).tapTimeout,0.2);
  assert.equal(resetRules(local).revision,4); assert.deepEqual(loadRules(local),DEFAULT_RULES);
  assert.deepEqual(loadRulesHistory(local).map(entry => entry.revision),[4,3,2,1]);
  assert.equal(JSON.parse(local.getItem(RULES_STORAGE_KEY)).version,3);
  assert.throws(() => rollbackRules(300,local));
  for (let i=0;i<35;i++) saveRules(DEFAULT_RULES,local);
  assert.equal(loadRulesHistory(local).length,30);
  local.setItem(RULES_STORAGE_KEY,'{broken'); assert.deepEqual(loadRules(local),DEFAULT_RULES);
  assert.throws(() => saveRules(DEFAULT_RULES,{getItem:()=>null,setItem:()=>{throw new Error('quota');}}),/保存失败/);
});
check('Monte Carlo reports template return and loss allocation honestly', () => {
  let seed=0xabcdef12;
  const random=() => {seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const result=simulateRules(DEFAULT_RULES,100000,random);
  assert.equal(result.kind,'outcome-template'); assert(Math.abs(result.theoreticalReturnRate-0.5755)<1e-8);
  assert(Math.abs(result.returnRate-result.theoreticalReturnRate)<0.015);
  assert(Math.abs(result.lossPercent-60)<1);
  assert.equal(result.lossCount+result.breakEvenCount+result.winCount,result.rounds);
  assert.equal(Object.values(result.bands).reduce((sum,band)=>sum+band.count,0),result.rounds);
  assert.equal(result.distribution.burnUnits,result.lossCount); assert.equal(result.distribution.platformUnits,0);
  const allLoss=simulateRules({...DEFAULT_RULES,lossWeight:100,breakEvenWeight:0,smallWinWeight:0,doubleWeight:0,highWinWeight:0,burnPercent:80,platformPercent:15,activityPercent:5},10000,()=>0);
  assert.equal(allLoss.returnRate,0); assert.equal(allLoss.distribution.burnUnits,8000); assert.equal(allLoss.distribution.platformUnits,1500); assert.equal(allLoss.distribution.activityUnits,500);
  assert.throws(()=>simulateRules(DEFAULT_RULES,9999));
  console.log(JSON.stringify({rounds:result.rounds,returnRate:result.returnRate,theoreticalReturnRate:result.theoreticalReturnRate,lossPercent:result.lossPercent,breakEvenPercent:result.breakEvenPercent,winPercent:result.winPercent}));
});
console.log(JSON.stringify({ok:true,cases}));
