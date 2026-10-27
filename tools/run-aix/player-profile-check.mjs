import assert from 'node:assert/strict';
import { ACHIEVEMENTS, PlayerProfile, PROFILE_STORAGE_KEY, PROFILE_VERSION, SKINS } from '../../resources/app/public/games/run-aix/player-profile.js';

const checks = [];
function check(name, run) { run(); checks.push(name); }
function memory(initial = null) {
  const values = new Map(initial ? [[PROFILE_STORAGE_KEY, initial]] : []);
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
}
function run(overrides = {}) {
  return { runId: 'run-1', levelId: 'level-1', distance: 200, completed: true, stars: 1,
    hits: 0, dodges: 5, crystals: 12, elapsed: 30.25, bestCombo: 10, ...overrides };
}

check('defaults are local-only, typed, and the first campaign level is unlocked', () => {
  const profile = new PlayerProfile(memory());
  assert.equal(profile.data.version, PROFILE_VERSION);
  assert.deepEqual(profile.data.settings, { sound: false, haptics: true, reducedMotion: false });
  assert.equal(profile.data.selectedSkin, 'aurora');
  assert.deepEqual(profile.data.completed, {});
  assert.deepEqual(profile.data.daily, {});
  assert.equal(profile.data.totalDistance, 0);
  assert.equal(profile.data.bestCombo, 0);
  assert.equal(profile.isUnlocked('level-1'), true);
  assert.equal(profile.isUnlocked('level-2'), false);
  assert.equal(profile.recordRun(run({ runId: 'locked', levelId: 'level-6' })).error, 'level-locked');
  assert.equal(profile.isUnlocked('daily'), false);
});

check('only a completed stage unlocks its successor, and the best result is monotonic', () => {
  const profile = new PlayerProfile(memory());
  assert.equal(profile.recordRun(run({ runId: 'failed', completed: false, stars: 0 })).ok, true);
  assert.equal(profile.isUnlocked('level-2'), false);
  assert.equal(profile.recordRun(run({ runId: 'clear-1' })).ok, true);
  assert.equal(profile.isUnlocked('level-2'), true);
  profile.recordRun(run({ runId: 'clear-2', distance: 180, stars: 2, crystals: 8, elapsed: 34, bestCombo: 7 }));
  assert.deepEqual(profile.bestScore('level-1'), { stars: 2, bestDistance: 200, bestTime: 30.25, crystals: 12, bestCombo: 10 });
  assert.equal(profile.isUnlocked('level-3'), false);
});

check('run IDs are idempotent and invalid IDs, levels, and summaries are rejected', () => {
  const profile = new PlayerProfile(memory());
  assert.equal(profile.recordRun(run()).ok, true);
  assert.deepEqual(profile.recordRun(run()), { ok: false, error: 'duplicate-run-id' });
  assert.equal(profile.recordRun(run({ runId: '', levelId: 'level-1' })).error, 'invalid-run-id');
  assert.equal(profile.recordRun(run({ runId: 'other', levelId: 'level-7' })).error, 'invalid-level');
  assert.equal(profile.recordRun(run({ runId: 'other', crystals: -1 })).error, 'invalid-summary');
  assert.equal(profile.recordRun(run({ runId: 'zero-stars', stars: 0 })).error, 'invalid-summary');
  assert.equal(profile.recordRun(run({ runId: 'failed-stars', completed: false, stars: 1 })).error, 'invalid-summary');
  assert.equal(profile.recordRun(run({ runId: 'invalid-date', date: '2026-10-24' })).error, 'invalid-summary');
  assert.equal(profile.recordRun(run({ runId: 'invalid-date', date: Infinity })).error, 'invalid-summary');
  assert.equal(profile.data.totalRuns, 1);
  assert.equal(profile.data.totalCrystals, 12);
  assert.equal(profile.data.totalDistance, 200);
});

check('daily and training records are retained without unlocking campaign content', () => {
  const profile = new PlayerProfile(memory());
  assert.equal(profile.recordRun(run({ runId: 'daily-1', levelId: 'daily', completed: false, stars: 0 })).ok, true);
  assert.equal(profile.recordRun(run({ runId: 'training-1', levelId: 'training', completed: true })).ok, true);
  assert.equal(profile.data.totalRuns, 2);
  assert.equal(profile.data.totalCrystals, 24);
  assert.equal(profile.data.totalDistance, 400);
  assert.equal(profile.isUnlocked('level-2'), false);
  assert.equal(profile.bestScore('daily'), null);
});

check('daily bests use the supplied China day, survive reloads, and never unlock campaign stages', () => {
  const storage = memory(), profile = new PlayerProfile(storage);
  const beforeMidnight = Date.parse('2026-10-24T15:59:59.999Z');
  const midnight = Date.parse('2026-10-24T16:00:00.000Z');
  profile.recordRun(run({ runId: 'daily-before', levelId: 'daily', date: beforeMidnight, completed: false, stars: 0, distance: 120, elapsed: 22, crystals: 7 }));
  assert.deepEqual(profile.bestDaily('2026-10-24'), { bestDistance: 120, bestTime: 0, stars: 0, crystals: 7, completed: false });
  profile.recordRun(run({ runId: 'daily-after', levelId: 'daily', date: midnight, stars: 2, elapsed: 35 }));
  profile.recordRun(run({ runId: 'daily-faster', levelId: 'daily', date: midnight + 1000, stars: 1, elapsed: 32, crystals: 10 }));
  profile.recordRun(run({ runId: 'daily-retry', levelId: 'daily', date: midnight + 2000, completed: false, stars: 0, distance: 180, elapsed: 28, crystals: 14 }));
  assert.equal(profile.recordRun(run({ runId: 'daily-after', levelId: 'daily', date: midnight })).error, 'duplicate-run-id');
  const loaded = new PlayerProfile(storage);
  assert.deepEqual(loaded.bestDaily('2026-10-25'), { bestDistance: 200, bestTime: 32, stars: 2, crystals: 14, completed: true });
  assert.equal(loaded.data.totalRuns, 4);
  assert.equal(loaded.data.totalDistance, 700);
  assert.equal(loaded.stars, 0);
  assert.deepEqual(loaded.unlockedSkins, ['aurora']);
  assert.equal(loaded.isUnlocked('level-2'), false);
  assert.equal(loaded.bestDaily('2026-02-30'), null);
  assert.equal(loaded.bestDaily('__proto__'), null);
  assert.equal(loaded.bestDaily('2026-10-26'), null);
  const snapshot = loaded.bestDaily('2026-10-25');
  snapshot.stars = 3;
  assert.equal(loaded.bestDaily('2026-10-25').stars, 2);
});

check('daily attempts without a date use the current China day', () => {
  const actualNow = Date.now;
  Date.now = () => Date.parse('2026-12-31T16:00:00.000Z');
  try {
    const profile = new PlayerProfile(memory());
    assert.equal(profile.recordRun(run({ levelId: 'daily' })).ok, true);
    assert.equal(profile.bestDaily().completed, true);
    assert.equal(profile.bestDaily('2027-01-01').stars, 1);
  } finally {
    Date.now = actualNow;
  }
});

check('career distance and best combo include failed, training, daily, and campaign attempts once each', () => {
  const storage = memory(), profile = new PlayerProfile(storage);
  profile.recordRun(run({ runId: 'training-career', levelId: 'training', distance: 83.5, bestCombo: 3 }));
  profile.recordRun(run({ runId: 'failed-career', completed: false, stars: 0, distance: 74.25, bestCombo: 14 }));
  profile.recordRun(run({ runId: 'clear-career', bestCombo: 9 }));
  assert.equal(profile.data.totalDistance, 357.75);
  assert.equal(profile.data.bestCombo, 14);
  assert.equal(profile.bestScore('level-1').bestCombo, 9);
  assert.equal(profile.recordRun(run({ runId: 'clear-career' })).error, 'duplicate-run-id');
  const loaded = new PlayerProfile(storage);
  assert.equal(loaded.data.totalDistance, 357.75);
  assert.equal(loaded.data.bestCombo, 14);
  assert.ok(loaded.achievements.some(item => item.id === 'combo-10'));
});

check('stars unlock cosmetics at 6 and 12, with equipped skins validated', () => {
  const profile = new PlayerProfile(memory());
  assert.deepEqual(SKINS.map(skin => skin.starsRequired), [0, 6, 12]);
  assert.deepEqual(profile.unlockedSkins, ['aurora']);
  assert.equal(profile.selectSkin('nebula'), false);
  for (let index = 1; index <= 4; index++) profile.recordRun(run({ runId: `six-${index}`, levelId: `level-${index}`, stars: 2 }));
  assert.equal(profile.stars, 8);
  assert.deepEqual(profile.unlockedSkins, ['aurora', 'nebula']);
  assert.equal(profile.selectSkin('nebula'), true);
  assert.equal(profile.data.selectedSkin, 'nebula');
  profile.recordRun(run({ runId: 'ten', levelId: 'level-5', stars: 2 }));
  profile.recordRun(run({ runId: 'twelve', levelId: 'level-6', stars: 2 }));
  assert.deepEqual(profile.unlockedSkins, ['aurora', 'nebula', 'sunrise']);
});

check('settings, achievements, and progress persist across reloads', () => {
  const storage = memory(), profile = new PlayerProfile(storage);
  assert.equal(profile.setSetting('sound', true), true);
  assert.equal(profile.setSetting('unknown', true), false);
  profile.recordRun(run());
  const loaded = new PlayerProfile(storage);
  assert.equal(loaded.data.settings.sound, true);
  assert.equal(loaded.data.totalRuns, 1);
  assert.ok(loaded.achievements.some(item => item.id === 'first-run'));
  assert.ok(loaded.achievements.some(item => item.id === 'first-clear'));
  assert.ok(loaded.achievements.some(item => item.id === 'untouched-clear'));
  assert.ok(loaded.achievements.some(item => item.id === 'combo-10'));
  assert.equal(loaded.data.achievements.length, 4);
  assert.ok(ACHIEVEMENTS.length >= loaded.data.achievements.length);
});

check('corrupt storage resets safely and storage quota failure does not block play', () => {
  const corrupt = memory('{broken');
  assert.equal(new PlayerProfile(corrupt).data.totalRuns, 0);
  const blocked = { getItem() { return null; }, setItem() { throw new Error('quota'); } };
  const profile = new PlayerProfile(blocked);
  assert.equal(profile.recordRun(run()).ok, true);
  assert.equal(profile.data.totalRuns, 1);
  assert.equal(profile.storageAvailable, false);
  const unavailable = new PlayerProfile({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
  assert.equal(unavailable.recordRun(run()).ok, true);
  assert.equal(unavailable.isUnlocked('level-2'), true);
  assert.equal(unavailable.storageAvailable, false);
  assert.equal(new PlayerProfile(null).recordRun(run()).ok, true);
});

check('legacy version-one profiles retain progress and settings while receiving new defaults', () => {
  const storage = memory(JSON.stringify({ version: 1, selectedSkin: 'nebula', settings: { sound: true, haptics: false },
    completed: { 'level-1': { stars: 3, bestDistance: 200, bestTime: 31, crystals: 15, bestCombo: 8 },
      'level-2': { stars: 3, bestDistance: 350, bestTime: 49, crystals: 20, bestCombo: 12 } },
    totalCrystals: 35, totalRuns: 4, achievements: ['first-run', 'first-clear'], runIds: ['old-run'] }));
  const profile = new PlayerProfile(storage);
  assert.equal(profile.stars, 6);
  assert.equal(profile.data.selectedSkin, 'nebula');
  assert.equal(profile.isUnlocked('level-3'), true);
  assert.deepEqual(profile.data.settings, { sound: true, haptics: false, reducedMotion: false });
  assert.deepEqual(profile.data.daily, {});
  assert.equal(profile.data.totalDistance, 0);
  assert.equal(profile.data.bestCombo, 12);
  assert.equal(profile.data.totalRuns, 4);
  assert.equal(profile.data.totalCrystals, 35);
  assert.equal(profile.recordRun(run({ runId: 'old-run' })).error, 'duplicate-run-id');
  assert.equal(profile.setSetting('reducedMotion', true), true);
  assert.equal(new PlayerProfile(storage).data.selectedSkin, 'nebula');
});

check('malformed completed records cannot unlock levels or cosmetics and invalid saved values are cleaned', () => {
  const storage = memory(JSON.stringify({ version: PROFILE_VERSION, selectedSkin: 'sunrise',
    completed: { 'level-1': {}, 'level-2': { stars: 0 }, 'level-3': { stars: -1 }, 'level-4': { stars: 4 },
      'level-5': { stars: '3' }, 'level-6': [] }, settings: { sound: 'yes', haptics: null, reducedMotion: true },
    daily: { '2026-02-30': { completed: true, stars: 3 }, '2026-10-24': { completed: true, stars: 0, bestDistance: 120 },
      '2026-10-25': { completed: true, stars: 2, bestDistance: 300, bestTime: 50, crystals: 22 } },
    totalDistance: -5, bestCombo: '100', totalRuns: -1, totalCrystals: '999', achievements: ['unknown', 'first-run', 'first-run'],
    runIds: ['saved-run', 'saved-run', '', 44] }));
  const profile = new PlayerProfile(storage);
  assert.deepEqual(profile.data.completed, {});
  assert.equal(profile.stars, 0);
  assert.equal(profile.data.selectedSkin, 'aurora');
  assert.equal(profile.isUnlocked('level-2'), false);
  assert.equal(profile.bestScore('__proto__'), null);
  assert.deepEqual(profile.data.settings, { sound: false, haptics: true, reducedMotion: true });
  assert.equal(profile.data.totalDistance, 0);
  assert.equal(profile.data.bestCombo, 0);
  assert.equal(profile.data.totalRuns, 0);
  assert.equal(profile.data.totalCrystals, 0);
  assert.deepEqual(profile.data.achievements, ['first-run']);
  assert.deepEqual(profile.data.runIds, ['saved-run']);
  assert.equal(profile.bestDaily('2026-02-30'), null);
  assert.deepEqual(profile.bestDaily('2026-10-24'), { bestDistance: 120, bestTime: 0, stars: 0, crystals: 0, completed: false });
  assert.equal(profile.bestDaily('2026-10-25').completed, true);
});

check('reset clears daily and career progress and public data snapshots cannot mutate stored progress', () => {
  const profile = new PlayerProfile(memory());
  profile.recordRun(run({ levelId: 'daily', date: Date.parse('2026-10-24T12:00:00Z') }));
  const snapshot = profile.data;
  snapshot.totalRuns = 900;
  snapshot.daily['2026-10-24'].stars = 3;
  assert.equal(profile.data.totalRuns, 1);
  assert.equal(profile.bestDaily('2026-10-24').stars, 1);
  profile.resetProgress();
  assert.equal(profile.data.totalRuns, 0);
  assert.equal(profile.data.totalDistance, 0);
  assert.equal(profile.data.bestCombo, 0);
  assert.deepEqual(profile.data.daily, {});
  assert.equal(profile.isUnlocked('level-2'), false);
});

console.log(JSON.stringify({ ok: true, count: checks.length, checks }, null, 2));
