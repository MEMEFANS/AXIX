// Isolated synthetic test data only. This file never reads browser or production data.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CHOICES, RULES, STORAGE_KEY, HashSession, hashHex, outcomeFromHash, verifyRecord } from '../../resources/app/public/games/hash-aix/core.js';

const checks = [];
async function check(name, action) { await action(); checks.push(name); }
function memory(raw) {
  const values = new Map(raw ? [[STORAGE_KEY, raw]] : []);
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function bytes(seed = 72) {
  let state = seed;
  return length => Uint8Array.from({ length }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  });
}
function fixture({ storage = memory(), seed = 72 } = {}) {
  let time = 1_800_000_000_000;
  return {
    storage, now: () => time, advance: milliseconds => { time += milliseconds; },
    session: new HashSession({ storage, now: () => time, randomBytes: bytes(seed) }),
  };
}
const independentHash = text => createHash('sha256').update(text, 'utf8').digest('hex');
async function complete(test, choice = 'odd', stake = 1) {
  assert.equal((await test.session.beginRound('timed')).ok, true);
  if (choice !== null) assert.equal((await test.session.wager(choice, stake)).ok, true);
  test.advance(18000);
  const result = await test.session.tick();
  assert.equal(result.ok, true); assert.equal(result.revealed, true);
  return result.record;
}

await check('SHA-256 vectors and all 16 last digits follow the public 50/50 rules', async () => {
  assert.equal(await hashHex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await hashHex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(CHOICES.length, 4);
  for (let digit = 0; digit < 16; digit++) {
    const outcome = outcomeFromHash('0'.repeat(63) + digit.toString(16));
    assert.equal(outcome.digit, digit);
    assert.equal(outcome.parity, digit % 2 ? 'odd' : 'even');
    assert.equal(outcome.size, digit < 8 ? 'small' : 'big');
    assert.equal(CHOICES.filter(choice => choice.digits.includes(outcome.hexDigit)).length, 2);
  }
  assert.ok(CHOICES.every(choice => choice.digits.length === 8));
  assert.equal(RULES.payoutMultiplier, 1.98);
});

await check('Commitment precedes a single wager and current seed changes apply only to the next round', async () => {
  const test = fixture(), session = test.session;
  assert.equal((await session.ready()).ok, true);
  assert.equal(session.phase, 'idle');
  const started = await session.beginRound('timed');
  assert.equal(started.ok, true);
  const first = session.current;
  assert.equal(first.commitment, independentHash(first.seed));
  assert.equal(first.closesAt - first.createdAt, 15000);
  assert.equal(first.revealsAt - first.closesAt, 3000);
  assert.equal(session.countdownMs, 15000);
  assert.equal((await session.beginRound('timed')).error, 'round-active');
  assert.equal((await session.setClientSeed('another-local-seed')).ok, true);
  assert.equal(session.current.clientSeed, first.clientSeed);
  const results = await Promise.all([session.wager('odd', 10), session.wager('even', 10)]);
  assert.equal(results.filter(item => item.ok).length, 1);
  assert.equal(results[1].error, 'already-entered');
  assert.equal(session.data.balanceCents, 99000);
  const snapshot = session.data; snapshot.balanceCents = 0; snapshot.pending.seed = '';
  assert.equal(session.data.balanceCents, 99000); assert.equal(session.current.seed, first.seed);
  test.advance(18000); await session.tick(); await session.beginRound('timed');
  assert.equal(session.current.clientSeed, 'another-local-seed');
});

await check('Close, reveal and repeated settlement have precise timing and integral credit accounting', async () => {
  const test = fixture(), session = test.session;
  await session.beginRound('timed'); await session.wager('odd', 7);
  const opening = session.current;
  test.advance(14999); assert.equal(session.phase, 'open'); assert.equal(session.countdownMs, 1);
  test.advance(1); assert.equal(session.phase, 'locked'); assert.equal(session.countdownMs, 3000);
  assert.equal((await session.wager('big', 2)).error, 'round-locked');
  await session.tick();
  test.advance(-1000); assert.equal(session.phase, 'locked'); assert.equal((await session.wager('small', 2)).error, 'round-locked');
  test.advance(3999); assert.equal((await session.tick()).revealed, false);
  test.advance(1);
  const ended = await session.tick();
  const expectedHash = independentHash(`${opening.seed}:${opening.clientSeed}:${opening.nonce}`);
  assert.equal(ended.record.hash, expectedHash);
  const expectedWin = Number.parseInt(expectedHash.at(-1), 16) % 2 === 1;
  assert.equal(ended.record.won, expectedWin);
  assert.equal(ended.record.payoutCents, expectedWin ? 1386 : 0);
  assert.equal(session.data.balanceCents, 100000 - 700 + (expectedWin ? 1386 : 0));
  const settled = JSON.stringify(session.data);
  for (let i = 0; i < 5; i++) assert.equal((await session.tick()).revealed, false);
  assert.equal(JSON.stringify(session.data), settled);
  assert.equal((await verifyRecord(ended.record)).ok, true);
});

await check('An observed round records an actual result with no invented stake, payout or win', async () => {
  const test = fixture();
  const record = await complete(test, null);
  assert.equal(record.choice, null); assert.equal(record.won, null);
  assert.equal(record.stakeCents, 0); assert.equal(record.payoutCents, 0); assert.equal(record.netCents, 0);
  assert.equal(test.session.data.balanceCents, 100000);
  assert.equal(test.session.data.stats.observed, 1); assert.equal(test.session.data.stats.played, 0);
  assert.equal((await verifyRecord(record)).ok, true);
});

await check('Refresh and two local tabs preserve the pending commitment and settle only once', async () => {
  const test = fixture(), first = test.session;
  await first.beginRound('timed'); await first.wager('small', 10);
  const original = first.current;
  const second = new HashSession({ storage: test.storage, now: test.now, randomBytes: bytes(98) });
  assert.equal((await second.ready()).restored, true);
  assert.equal(second.current.seed, original.seed); assert.equal(second.current.commitment, original.commitment);
  assert.equal(second.data.balanceCents, 99000);
  test.advance(24000);
  const settlements = await Promise.all([first.tick(), second.tick()]);
  assert.equal(settlements.filter(result => result.revealed === true).length, 1);
  await first.ready(); await second.ready();
  assert.equal(first.data.stats.rounds, 1); assert.deepEqual(first.data, second.data);
  const restored = new HashSession({ storage: test.storage, now: test.now });
  assert.equal((await restored.ready()).ok, true); assert.equal(restored.phase, 'revealed');
  assert.equal((await restored.tick()).revealed, false);
});

await check('Shared-storage concurrent entries cannot apply two stakes to the same local round', async () => {
  const test = fixture();
  await test.session.beginRound('timed');
  const second = new HashSession({ storage: test.storage, now: test.now }); await second.ready();
  const results = await Promise.all([test.session.wager('even', 10), second.wager('big', 20)]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.ok(['already-entered', 'storage-conflict'].includes(results.find(result => !result.ok).error));
  await test.session.ready(); await second.ready();
  assert.deepEqual(test.session.data, second.data);
  assert.equal(test.session.data.balanceCents, 100000 - test.session.current.stakeCents);
});

await check('Invalid choices, stake sizes and future seeds leave balances and rounds unchanged', async () => {
  const test = fixture(), session = test.session;
  await session.beginRound('timed');
  const original = JSON.stringify(session.data);
  for (const stake of [0, -1, .5, 101, '10']) assert.equal((await session.wager('odd', stake)).error, 'invalid-stake');
  assert.equal((await session.wager('unknown', 10)).error, 'invalid-choice');
  for (const value of ['', 'with spaces', 'a'.repeat(65), null]) assert.equal((await session.setClientSeed(value)).error, 'invalid-client-seed');
  assert.equal((await session.refill()).error, 'refill-not-needed');
  assert.equal(JSON.stringify(session.data), original);
});

await check('Disabled and exhausted storage remain playable in the current page', async () => {
  for (const storage of [null, { getItem() { throw new Error('disabled'); }, setItem() { throw new Error('disabled'); } }, { getItem() { return null; }, setItem() { throw new Error('quota'); } }]) {
    const test = fixture({ storage });
    const record = await complete(test, 'even', 10);
    assert.equal(test.session.storageAvailable, false);
    assert.equal(test.session.data.records.length, 1);
    assert.equal((await verifyRecord(record)).ok, true);
    await test.session.beginRound('timed'); assert.equal(test.session.current.nonce, 2);
  }
});

await check('Unreadable stored data is reported and preserved rather than silently replaced', async () => {
  const storage = memory('{incomplete-json');
  const session = new HashSession({ storage });
  assert.equal((await session.ready()).error, 'stored-data-invalid');
  assert.equal(session.loadError, 'stored-data-invalid');
  assert.equal((await session.beginRound('timed')).ok, false);
  assert.equal(storage.getItem(STORAGE_KEY), '{incomplete-json');
});

await check('Calculation verification rejects inconsistent displayed outcomes and payouts', async () => {
  const test = fixture(); const record = await complete(test, 'small', 3);
  assert.equal((await verifyRecord(record)).ok, true);
  assert.equal((await verifyRecord({ ...record, digit: (record.digit + 1) % 16 })).resultOk, false);
  assert.equal((await verifyRecord({ ...record, payoutCents: record.payoutCents + 1 })).payoutOk, false);
  assert.equal((await verifyRecord(null)).error, 'invalid-record');
});

await check('Long synthetic play retains 100 genuine local records and exact lifetime totals', async () => {
  const test = fixture(); let payoutCents = 0, wins = 0;
  for (let i = 0; i < 125; i++) {
    const record = await complete(test, 'odd', 1);
    const independent = independentHash(`${record.seed}:${record.clientSeed}:${record.nonce}`);
    const won = Number.parseInt(independent.at(-1), 16) % 2 === 1;
    assert.equal(record.won, won); if (won) { wins++; payoutCents += 198; }
  }
  const data = test.session.data;
  assert.equal(data.records.length, 100); assert.equal(data.records[0].nonce, 125); assert.equal(data.records.at(-1).nonce, 26);
  assert.equal(data.stats.rounds, 125); assert.equal(data.stats.wins, wins);
  assert.equal(data.stats.stakedCents, 12500); assert.equal(data.stats.payoutCents, payoutCents);
  assert.equal(data.balanceCents, 100000 - 12500 + payoutCents);
  const restored = new HashSession({ storage: test.storage, now: test.now }); assert.equal((await restored.ready()).ok, true);
  assert.deepEqual(restored.data, data);
});

await check('Free refill is explicit, blocked by an unsettled entry, and tracked separately from results', async () => {
  const test = fixture({ seed: 1 });
  // Always the same choice and stake, with no selection or alteration of outcomes.
  for (let i = 0; i < 3000 && test.session.data.balanceCents >= 10000; i++) await complete(test, 'odd', 100);
  assert.ok(test.session.data.balanceCents < 10000, 'Synthetic fixed-choice session reached the refill threshold.');
  if (test.session.data.balanceCents >= 100) {
    await test.session.beginRound('timed'); await test.session.wager('odd', 1);
    assert.equal((await test.session.refill()).error, 'round-active');
    test.advance(18000); await test.session.tick();
  }
  const before = test.session.data, result = await test.session.refill();
  assert.equal(result.ok, true); assert.equal(result.addedCents, 100000 - before.balanceCents);
  assert.equal(test.session.data.balanceCents, 100000); assert.equal(test.session.data.freeRefills, 1);
  assert.deepEqual(test.session.data.records, before.records);
  const restored = new HashSession({ storage: test.storage, now: test.now }); assert.equal((await restored.ready()).ok, true);
  assert.equal(restored.data.freeRefills, 1);
});

await check('Quick rounds wait indefinitely for an explicit action with an unchanged commitment', async () => {
  const test = fixture(), session = test.session;
  assert.equal((await session.beginRound()).ok, true);
  const original = session.current;
  assert.equal(original.mode, 'quick'); assert.equal(original.closesAt, null); assert.equal(original.revealsAt, null);
  assert.equal(original.commitment, independentHash(original.seed));
  test.advance(86400000);
  for (let i = 0; i < 3; i++) assert.equal((await session.tick()).revealed, false);
  assert.equal(session.phase, 'open'); assert.equal(session.countdownMs, 0);
  assert.deepEqual(session.current, original);
  assert.equal(session.data.balanceCents, 100000); assert.equal(session.data.stats.rounds, 0);
  await session.setClientSeed('quick-next-seed');
  assert.equal(session.current.clientSeed, original.clientSeed);
  const restored = new HashSession({ storage: test.storage, now: test.now });
  assert.equal((await restored.ready()).restored, true); assert.deepEqual(restored.current, original);
});

await check('Quick confirmation locks immediately, deducts once and reveals exactly after 1,600 ms', async () => {
  const test = fixture(), session = test.session;
  await session.beginRound(); const original = session.current;
  const results = await Promise.all([session.wager('odd', 7), session.wager('even', 8)]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results[1].error, 'round-locked'); assert.equal((await session.observe()).error, 'already-entered');
  assert.equal(session.data.balanceCents, 99300); assert.equal(session.phase, 'locked');
  assert.equal(session.countdownMs, 1600); assert.equal(session.current.closesAt, test.now());
  test.advance(1599); assert.equal((await session.tick()).revealed, false);
  test.advance(1); const result = await session.tick(); assert.equal(result.revealed, true);
  const hash = independentHash(`${original.seed}:${original.clientSeed}:${original.nonce}`);
  const won = parseInt(hash.at(-1), 16) % 2 === 1;
  assert.equal(result.record.hash, hash); assert.equal(result.record.won, won);
  assert.equal(session.data.balanceCents, 99300 + (won ? 1386 : 0));
  assert.equal((await verifyRecord(result.record)).ok, true);
  const settled = session.data;
  for (let i = 0; i < 4; i++) assert.equal((await session.tick()).revealed, false);
  assert.deepEqual(session.data, settled);
});

await check('Pending quick rounds survive refresh and concurrent sessions settle the shared stake once', async () => {
  const test = fixture(), first = test.session;
  await first.beginRound(); await first.wager('big', 20); const pending = first.current;
  const second = new HashSession({ storage: test.storage, now: test.now });
  assert.equal((await second.ready()).ok, true); assert.deepEqual(second.current, pending);
  assert.equal((await second.wager('small', 10)).error, 'round-locked');
  test.advance(1600);
  const results = await Promise.all([first.tick(), second.tick()]);
  assert.equal(results.filter(result => result.revealed).length, 1);
  await first.ready(); await second.ready(); assert.deepEqual(first.data, second.data);
  assert.equal(first.data.stats.rounds, 1); assert.equal(first.data.stats.stakedCents, 2000);
  assert.equal(first.data.balanceCents, 98000 + first.data.records[0].payoutCents);
  const third = new HashSession({ storage: test.storage, now: test.now });
  assert.equal((await third.ready()).ok, true); assert.equal((await third.tick()).revealed, false);
  assert.deepEqual(third.data, first.data);
});

await check('Quick observation is explicit, repeat-safe and never consumes or returns credits', async () => {
  const test = fixture(), session = test.session;
  await session.beginRound(); test.advance(50000);
  const results = await Promise.all([session.observe(), session.observe(), session.wager('odd', 10)]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(session.current.choice, null); assert.equal(session.data.balanceCents, 100000);
  test.advance(1600); const result = await session.tick();
  assert.equal(result.record.won, null); assert.equal(result.record.netCents, 0);
  assert.equal(session.data.stats.observed, 1); assert.equal(session.data.stats.played, 0);
  assert.equal((await verifyRecord(result.record)).ok, true);
});

await check('Legacy records without a mode and a pending timed round coexist with new quick records', async () => {
  const test = fixture(); await complete(test, 'even', 5); await test.session.beginRound('timed'); await test.session.wager('small', 10);
  const legacy = JSON.parse(test.storage.getItem(STORAGE_KEY));
  delete legacy.pending.mode; for (const record of legacy.records) delete record.mode;
  test.storage.setItem(STORAGE_KEY, JSON.stringify(legacy));
  const session = new HashSession({ storage: test.storage, now: test.now });
  assert.equal((await session.ready()).ok, true); assert.equal(session.current.mode, undefined);
  assert.equal(session.current.revealsAt - session.current.createdAt, 18000);
  test.advance(18000); assert.equal((await session.tick()).revealed, true);
  const legacyCompleted = session.data;
  await session.setClientSeed('mixed-next'); await session.beginRound();
  assert.equal(session.current.mode, 'quick'); assert.equal(session.current.clientSeed, 'mixed-next');
  await session.observe(); test.advance(1600); await session.tick();
  assert.equal(session.data.balanceCents, legacyCompleted.balanceCents);
  assert.equal(session.data.stats.rounds, 3); assert.deepEqual(session.data.records.slice(1), legacyCompleted.records);
  for (const record of session.data.records) assert.equal((await verifyRecord(record)).ok, true);
  const restored = new HashSession({ storage: test.storage, now: test.now });
  assert.equal((await restored.ready()).ok, true); assert.deepEqual(restored.data, session.data);
});

await check('Invalid round modes and invalid quick entries never change the local ledger', async () => {
  const test = fixture(), session = test.session; await session.ready();
  const empty = session.data;
  for (const mode of [null, '', 'automatic', 1]) assert.equal((await session.beginRound(mode)).error, 'invalid-mode');
  assert.deepEqual(session.data, empty); await session.beginRound(); const pending = session.data;
  for (const stake of [-1, 0, .5, 101, '10']) assert.equal((await session.wager('odd', stake)).error, 'invalid-stake');
  assert.equal((await session.wager('unknown', 10)).error, 'invalid-choice');
  assert.deepEqual(session.data, pending);
  test.advance(-1);
  assert.equal((await session.wager('odd', 10)).error, 'clock-unavailable');
  assert.equal((await session.observe()).error, 'clock-unavailable');
  assert.deepEqual(session.data, pending);
});

console.log(JSON.stringify({ ok: true, passed: checks.length, checks }, null, 2));
