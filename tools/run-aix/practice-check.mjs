import assert from 'node:assert/strict';
import { PracticeStore, chinaDay } from '../../resources/app/public/games/run-aix/store.js';

const KEY = 'run-aix:practice:v1';
const checks = [];
const check = (name, run) => { run(); checks.push(name); };
function memory() {
  const values = new Map();
  return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), values };
}
function record(id, stake = 10, multiplier = 0, distance = 45, reason = 'collision') {
  return { id, stake, multiplier, distance, reason, payout: Math.round(stake * multiplier * 10) / 10, date: Date.now() };
}
function finish(store, id, stake = 10, multiplier = 0, distance = 45, reason = 'collision') {
  assert.equal(store.beginRound(stake, id).ok, true);
  assert.equal(store.settle(record(id, stake, multiplier, distance, reason)), true);
  return store.data.records[0];
}
function withClock(time, run) {
  const original = Date.now; let current = Date.parse(time);
  Date.now = () => current;
  try { run(milliseconds => { current += milliseconds; }); } finally { Date.now = original; }
}

check('兼容 spend → settle；试玩积分扣返、刷新恢复与结算幂等', () => {
  const storage = memory(); const store = new PracticeStore(storage);
  assert.equal(store.spend(10), true); assert.equal(store.data.credits, 990);
  assert.equal(store.spend(101), false);
  const result = { id: 'legacy', payout: 20, multiplier: 2, distance: 200, date: Date.now() };
  assert.equal(store.settle(result), true); assert.equal(store.settle(result), false);
  assert.equal(store.data.credits, 1010);
  assert.equal(new PracticeStore(storage).data.credits, 1010);
  assert.equal(new PracticeStore(storage).settle(result), false);
});

check('预扣与快照可刷新恢复，同 ID 开局和结算不会重复记账', () => {
  const storage = memory(); const store = new PracticeStore(storage);
  assert.equal(store.beginRound(10, 'pending', { id: 'pending', stake: 10, distance: 0 }).ok, true);
  assert.equal(store.beginRound(10, 'pending').replayed, true);
  assert.equal(store.data.credits, 990); assert.equal(store.data.totalRounds, 1);
  assert.equal(store.beginRound(10, 'other').error, 'pending-round');
  assert.equal(store.refill(), false);
  assert.equal(store.checkpointRound({ id: 'wrong', stake: 10, distance: 200 }), false);
  assert.equal(store.checkpointRound({ id: 'pending', stake: 10, distance: 200, floor: 2 }), true);
  const reloaded = new PracticeStore(storage);
  const recovered = reloaded.recoverPending(); assert.equal(recovered.snapshot.distance, 200);
  recovered.snapshot.distance = 0; assert.equal(reloaded.recoverPending().snapshot.distance, 200);
  assert.equal(reloaded.settle(record('pending', 10, 2, 200, 'take')), true);
  assert.equal(store.settle(record('pending', 10, 2, 200, 'take')), false);
  assert.equal(store.data.credits, 1010); assert.equal(store.recoverPending(), null);
});

check('无预扣、错 ID、负数、NaN、无限值和不一致返还都不能修改账本', () => {
  const store = new PracticeStore(memory());
  assert.equal(store.settle(record('unbacked', 10, 5, 500)), false);
  assert.equal(store.beginRound(10, 'valid').ok, true);
  const valid = record('valid', 10, 2, 200);
  const invalid = [null, undefined, {}, { ...valid, id: 'other' }, { ...valid, payout: -1 },
    { ...valid, payout: NaN }, { ...valid, payout: Infinity }, { ...valid, payout: 9999 },
    { ...valid, distance: Infinity }, { ...valid, distance: -1 }, { ...valid, multiplier: 11 },
    { ...valid, stake: 20 }, { ...valid, date: Date.now() - 60000 },
    { ...valid, date: Date.now() + 120000 }, { ...valid, reason: 'abort' }];
  const before = JSON.stringify(store.data);
  for (const value of invalid) { assert.equal(store.settle(value), false); assert.equal(JSON.stringify(store.data), before); }
  assert.equal(store.settle(valid), true); assert.equal(store.data.credits, 1010);
});

check('最近仅留 20 局，历史结算 ID 与历史最佳纪录仍保留', () => {
  const storage = memory(); const store = new PracticeStore(storage);
  finish(store, 'best-old', 1, 5, 500, 'finish');
  for (let index = 0; index < 24; index++) finish(store, `history-${index}`, 1, 1, 100, 'take');
  assert.equal(store.data.records.length, 20);
  assert.equal(store.data.records.some(value => value.id === 'best-old'), false);
  assert.equal(store.getLeaderboard('all')[0].id, 'best-old');
  const reloaded = new PracticeStore(storage);
  assert.equal(reloaded.beginRound(1, 'best-old').error, 'already-settled');
  assert.equal(reloaded.settle(record('best-old', 1, 5, 500)), false);
  assert.equal(reloaded.data.credits, 1004); assert.equal(reloaded.data.totalRounds, 25);
});

check('只给全损发独立安慰积分，日上限生效，作废和保本不赠送', () => {
  const store = new PracticeStore(memory(), { consolationPerPoint: 2, consolationDailyCap: 25 });
  assert.equal(finish(store, 'loss-1').consolationAwarded, 20);
  assert.equal(finish(store, 'loss-2').consolationAwarded, 5);
  assert.equal(finish(store, 'loss-3').consolationAwarded, 0);
  assert.equal(store.data.consolation, 25); assert.equal(store.data.credits, 970);
  finish(store, 'breakeven', 10, 1, 100, 'take'); assert.equal(store.data.consolation, 25);
  assert.equal(store.beginRound(10, 'abort').ok, true); assert.equal(store.abortPending(), true);
  assert.equal(store.abortPending(), false); assert.equal(store.data.consolation, 25);
  assert.equal(store.getDailyStatus().consolationEarned, 25);
  store.refill(); assert.equal(store.data.credits, 1000); assert.equal(store.data.consolation, 25);
});

check('固定奖品概率公示，抽奖花费与日次数检查，重试和刷新不重复发奖', () => {
  const storage = memory(); const store = new PracticeStore(storage, { lotteryDailyLimit: 3 });
  const prizes = store.lotteryPrizes(); assert.equal(prizes.reduce((sum, prize) => sum + prize.probability, 0), 1);
  assert.deepEqual(prizes.map(prize => prize.probability), [0.6, 0.25, 0.1, 0.05]);
  assert.equal(store.draw('not-funded', () => 0).error, 'insufficient-consolation');
  finish(store, 'funds', 100); assert.equal(store.data.consolation, 100); assert.equal(store.data.credits, 900);
  const initial = JSON.stringify(store.data);
  assert.equal(store.draw('invalid', () => NaN).error, 'invalid-random');
  assert.equal(store.draw('invalid', () => { throw new Error('rng unavailable'); }).error, 'invalid-random');
  assert.equal(JSON.stringify(store.data), initial);
  assert.equal(store.draw('five', () => 0.6).draw.prize.amount, 5);
  assert.equal(store.draw('twenty', () => 0.85).draw.prize.amount, 20);
  assert.equal(store.draw('skin', () => 0.99).draw.prize.type, 'cosmetic');
  assert.equal(store.data.credits, 925); assert.equal(store.data.consolation, 70);
  assert.deepEqual(store.data.cosmetics, ['starlight']);
  assert.equal(store.draw('limit', () => 0).error, 'daily-limit');
  const reloaded = new PracticeStore(storage, { lotteryDailyLimit: 3 });
  assert.equal(reloaded.draw('twenty', () => 0).replayed, true);
  assert.equal(reloaded.data.credits, 925); assert.equal(reloaded.data.consolation, 70);
  const empty = new PracticeStore(memory(), { lotteryDailyLimit: 0 });
  assert.equal(empty.draw('disabled').error, 'daily-limit');
});

check('谢谢参与确实扣安慰积分且不发试玩积分，装扮按集合收藏', () => {
  const store = new PracticeStore(memory()); finish(store, 'funds', 100);
  assert.equal(store.draw('thanks', () => 0).draw.prize.type, 'none');
  assert.equal(store.data.credits, 900); assert.equal(store.data.consolation, 90);
  store.draw('skin-1', () => 0.99); store.draw('skin-2', () => 0.99);
  assert.deepEqual(store.data.cosmetics, ['starlight']); assert.equal(store.data.consolation, 70);
});

check('按中国时区换日，次数/安慰日上限/每日榜重置，总榜与余额保留', () => {
  withClock('2026-10-20T15:59:59.000Z', advance => {
    const store = new PracticeStore(memory(), { consolationDailyCap: 10, lotteryDailyLimit: 1, dailyRoundLimit: 2 });
    finish(store, 'old-day'); store.draw('old-draw', () => 0);
    assert.equal(store.getDailyStatus().day, '2026-10-20');
    assert.equal(store.getLeaderboard('daily').length, 1);
    advance(2000);
    assert.equal(store.getDailyStatus().day, '2026-10-21');
    assert.equal(store.getDailyStatus().rounds, 0); assert.equal(store.getDailyStatus().draws, 0);
    assert.equal(store.getDailyStatus().remainingConsolation, 10);
    assert.equal(store.getLeaderboard('daily').length, 0); assert.equal(store.getLeaderboard('all').length, 1);
    finish(store, 'new-day'); assert.equal(store.data.consolation, 10);
    assert.equal(store.getLeaderboard('daily')[0].id, 'new-day');
    assert.equal(store.getLeaderboard('all').length, 2);
  });
  assert.equal(chinaDay(Date.parse('2026-10-20T15:59:59Z')), '2026-10-20');
  assert.equal(chinaDay(Date.parse('2026-10-20T16:00:00Z')), '2026-10-21');
});

check('冷却单位秒，日对局上限包含主动结束与作废，新规则不覆盖已有积分', () => {
  withClock('2026-10-20T04:00:00Z', advance => {
    const store = new PracticeStore(memory(), { roundCooldown: 5, dailyRoundLimit: 2 });
    finish(store, 'first');
    assert.equal(store.beginRound(10, 'cooldown').error, 'cooldown');
    assert.equal(store.getDailyStatus().cooldownMs, 5000); advance(5001);
    assert.equal(store.beginRound(10, 'second').ok, true); store.abortPending();
    advance(5001); assert.equal(store.beginRound(10, 'third').error, 'daily-limit');
    store.setRules({ initialCredits: 2000, minStake: 2, maxStake: 20 });
    assert.equal(store.data.credits, 980); assert.equal(store.beginRound(1, 'too-low').error, 'invalid-stake');
    assert.equal(store.refill(), true); assert.equal(store.data.credits, 2000);
  });
});

check('本机模拟分配守恒，可配置曲线保留六位精度，异常比例不产生负数', () => {
  const store = new PracticeStore(memory(), { burnPercent: 50, platformPercent: 50, activityPercent: 0 });
  const result = finish(store, 'fraction', 1, 0.9, 90);
  assert.ok(result.simulatedBurned >= 0 && result.simulatedPlatform >= 0 && result.simulatedActivity >= 0);
  assert.equal(result.simulatedBurned + result.simulatedPlatform + result.simulatedActivity, 0.1);
  assert.equal(store.data.economy.spent, 1); assert.equal(store.data.economy.paid, 0.9);
  const fallback = new PracticeStore(memory(), { burnPercent: 300 });
  assert.equal(finish(fallback, 'fallback').simulatedBurned, 10);
  const custom = new PracticeStore(memory());
  assert.equal(custom.beginRound(3, 'custom').ok, true);
  assert.equal(custom.settle({ ...record('custom', 3, 2.05, 305), payout: 6.15 }), true);
  assert.equal(custom.data.credits, 1003.15);
  finish(custom, 'long-custom', 1, 10, 2000, 'finish');
  assert.equal(new PracticeStore(custom.storage).getLeaderboard('all')[0].distance, 2000);
});

check('存储禁用或配额异常时可继续内存试玩，刷新操作不重复处理旧余额', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  const store = new PracticeStore(broken); finish(store, 'memory', 10, 2, 200);
  assert.equal(store.data.credits, 1010); assert.equal(store.storageAvailable, false);
  assert.equal(store.settle(record('memory', 10, 2, 200)), false);
  assert.equal(store.data.credits, 1010);
  assert.equal(new PracticeStore(null).data.credits, 1000);
});

check('损坏 JSON、非法余额、混杂记录与损坏快照不导致异常或注入返还', () => {
  for (const serialized of ['{', 'null', JSON.stringify({ credits: -1, records: [] }), JSON.stringify({ credits: '1000', records: [] })]) {
    const storage = memory(); storage.setItem(KEY, serialized);
    assert.equal(new PracticeStore(storage).data.credits, 1000);
  }
  const storage = memory();
  storage.setItem(KEY, JSON.stringify({ credits: 700, records: [{ id: 'fake', payout: 9999, date: Date.now(), multiplier: 0, distance: 0 }], pending: { id: 'bad', stake: -10, date: Date.now() }, draws: [{ id: 'bad', prizeId: 'real-aix', cost: 10, date: Date.now() }] }));
  const store = new PracticeStore(storage); assert.equal(store.data.credits, 700);
  assert.deepEqual(store.data.records, []); assert.deepEqual(store.data.draws, []); assert.equal(store.recoverPending(), null);
  assert.equal(store.beginRound(10, 'circular').ok, true);
  const snapshot = { id: 'circular', stake: 10 }; snapshot.self = snapshot;
  assert.equal(store.checkpointRound(snapshot), false); assert.equal(store.abortPending(), true);
});

console.log(JSON.stringify({ ok: true, checks, count: checks.length }, null, 2));
