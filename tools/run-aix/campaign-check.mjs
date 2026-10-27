import assert from 'node:assert/strict';
import { CampaignEngine } from '../../resources/app/public/games/run-aix/campaign-engine.js';
import { LEVELS, TRAINING_LEVEL, TRAINING_STAGES, WORLDS, getLevel, createCampaignCatalog } from '../../resources/app/public/games/run-aix/campaign.js';
import { OBSTACLES } from '../../resources/app/public/games/run-aix/config.js';
import { obstacleRow } from '../../resources/app/public/games/run-aix/difficulty.js';

const checks = [];
const check = (name, fn) => { fn(); checks.push(name); };
const seeded = initial => { let seed = initial >>> 0; return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; }; };
const hazard = (id = 'btc', lane = 1, ahead = 1.6) => ({ ...OBSTACLES.find(item => item.id === id), lane, ahead, passed: false });
function running(level = 'level-1', random = seeded(11), onEvent = () => {}) {
  const engine = new CampaignEngine({ level, random, onEvent });
  assert.equal(engine.start(), true);
  for (let i = 0; i < 62; i++) engine.update(.05);
  assert.equal(engine.state, 'running');
  return engine;
}

// Decisions and taps occur only every 0.4 seconds, including a possible
// second lane change. This checks readable reaction time, not an omniscient
// controller steering on every rendered frame.
function drive(engine, dt = .05, { tap = true } = {}) {
  if (engine.state === 'lobby') assert.equal(engine.start(), true);
  let nextDecision = .4;
  for (let frame = 0; frame < 20000 && engine.state !== 'ended'; frame++) {
    if (engine.state === 'running' && engine.time + 1e-7 >= nextDecision) {
      nextDecision += .4;
      if (tap) engine.tap();
      const upcoming = engine.obstacles.filter(item => !item.passed && item.ahead > 1.5 && item.ahead <= engine.rules.warningDistance)
        .sort((a, b) => a.ahead - b.ahead);
      if (upcoming.length) {
        const row = upcoming.filter(item => Math.abs(item.ahead - upcoming[0].ahead) < .01);
        if (row.some(item => item.lane === engine.lane)) {
          const safe = [0, 1, 2].filter(lane => !row.some(item => item.lane === lane))
            .sort((a, b) => Math.abs(a - engine.lane) - Math.abs(b - engine.lane))[0];
          if (safe !== undefined) engine.move(Math.sign(safe - engine.lane));
        }
      }
    }
    engine.update(dt);
  }
  assert.equal(engine.state, 'ended', `${engine.levelId} never ended`);
  return engine.result;
}

check('three worlds and six levels expose stable campaign IDs', () => {
  assert.equal(WORLDS.length, 3);
  assert.deepEqual(LEVELS.map(level => level.id), ['level-1', 'level-2', 'level-3', 'level-4', 'level-5', 'level-6']);
  assert.deepEqual(LEVELS.map(level => level.distance), [200, 250, 300, 350, 400, 500]);
  assert.equal(getLevel('training'), TRAINING_LEVEL);
  assert.equal(getLevel('missing'), null);
});

check('campaign uses skill rules, automatic checkpoints and no outcome draw', () => {
  for (const level of [...LEVELS, TRAINING_LEVEL]) {
    assert.equal(level.rules.mode, 'skill');
    assert.equal(level.rules.maxDistance, level.distance);
    assert.equal(level.rules.continuousTapRequired, false);
    assert.ok(level.rules.baseSpeed <= level.rules.maxSpeed && level.rules.maxSpeed <= level.rules.rocketSpeed);
  }
  let randomCalls = 0;
  const engine = new CampaignEngine({ random: () => { randomCalls += 1; return .5; } });
  assert.equal(engine.start(), true);
  assert.equal(engine.outcome, null);
  assert.equal(randomCalls, 0, 'starting a campaign must not pre-draw an ending');
  const events = [];
  const result = drive(new CampaignEngine({ level: 'level-2', random: seeded(3), onEvent: name => events.push(name) }));
  assert.equal(result.completed, true);
  assert.equal(events.filter(name => name === 'campaignCheckpoint').length, 1);
  assert.equal(events.includes('checkpoint'), false, 'classic financial checkpoint must stay internal');
  assert.equal('stake' in result || 'payout' in result || 'multiplier' in result, false);
});

check('campaign ignores local operator storage and keeps world themes in every generator scene band', () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let reads = 0;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { reads += 1; throw new Error('operator storage must not be read'); } });
  try {
    for (const level of LEVELS) {
      const engine = new CampaignEngine({ level });
      assert.equal(engine.sceneIndex, level.world);
      const catalog = createCampaignCatalog(level);
      const allowed = new Set(Object.entries(catalog).filter(([, entry]) => entry.enabled).map(([id]) => id));
      assert.ok(allowed.size > 0 && allowed.size < OBSTACLES.length);
      for (const progress of [.05, .4, .8]) {
        for (let seed = 0; seed < 20; seed++) {
          const row = obstacleRow(seeded(seed), level.distance * progress, 1, level.rules, catalog);
          assert.ok(row.obstacles.length > 0, `${level.id} has an empty technical scene band`);
          assert.ok(row.obstacles.every(item => allowed.has(item.id)));
        }
      }
    }
    const daily = new CampaignEngine({ level: { ...getLevel('level-3'), id: 'daily' }, random: seeded(100) });
    assert.equal(daily.sceneIndex, 1);
    assert.equal(drive(daily).completed, true);
    assert.equal(reads, 0);
  } finally {
    if (prior) Object.defineProperty(globalThis, 'localStorage', prior);
    else delete globalThis.localStorage;
  }
});

check('first level has only single-lane rows and protects the teaching opening', () => {
  const level = getLevel('level-1');
  assert.equal(level.rules.doubleChanceStart, 0);
  assert.equal(level.rules.doubleChanceEnd, 0);
  for (let seed = 0; seed < 50; seed++) for (const distance of [18, 80, 140, 190]) {
    assert.equal(obstacleRow(seeded(seed), distance, 1, level.rules, createCampaignCatalog(level)).obstacles.length, 1);
  }
  const engine = running('level-1');
  engine.distance = 35; engine.speed = 20; engine.obstacles = [hazard('btc')];
  engine.update(.05);
  assert.equal(engine.state, 'running'); assert.equal(engine.hearts, 3); assert.equal(engine.hits, 0);
});

check('all six levels finish at 20, 30 and 60 FPS with a 0.4 second reaction controller across eight seeds', () => {
  for (const level of LEVELS) for (const fps of [20, 30, 60]) for (let seed = 0; seed < 8; seed++) {
    const engine = new CampaignEngine({ level, random: seeded(seed) });
    const result = drive(engine, 1 / fps);
    assert.equal(result.completed, true, `${level.id}, ${fps} FPS, seed ${seed}: ${JSON.stringify(result)}`);
    assert.ok(engine.collectibles.every(item => item.distance <= level.distance), 'unreachable crystals beyond finish');
  }
});

check('training replays an identical wide single-obstacle road, has three stages and needs no boost', () => {
  const events = [];
  const first = new CampaignEngine({ level: 'training', random: () => { throw new Error('training must not draw random'); }, onEvent: (name, data) => { if (name === 'trainingStage') events.push(data.index); } });
  first.start();
  const road = JSON.stringify({ obstacles: first.obstacles, collectibles: first.collectibles });
  assert.equal(first.obstacles.length, 2);
  assert.ok(first.obstacles[1].ahead - first.obstacles[0].ahead >= 45);
  assert.equal(drive(first, 1 / 60, { tap: false }).completed, true);
  assert.deepEqual(events, TRAINING_STAGES.map(stage => stage.index));
  assert.equal(first.start(), true);
  assert.equal(JSON.stringify({ obstacles: first.obstacles, collectibles: first.collectibles }), road);
  assert.equal(first.trainingStage, 0);
  for (const fps of [20, 30, 60]) {
    assert.equal(drive(new CampaignEngine({ level: 'training' }), 1 / fps, { tap: false }).completed, true);
  }
});

check('three hearts, invulnerability, paused clocks and final collision summary stay consistent', () => {
  const engine = running('level-2');
  engine.distance = 80; engine.speed = 20; engine.obstacles = [hazard('btc')];
  engine.update(.05);
  assert.equal(engine.state, 'running'); assert.equal(engine.hearts, 2); assert.ok(engine.invulnerable > .9);
  engine.obstacles = [hazard('eth')]; engine.update(.05);
  assert.equal(engine.hearts, 2, 'invulnerability must prevent chained damage');
  engine.pause(); const frozen = JSON.stringify({ distance: engine.distance, time: engine.time, invulnerable: engine.invulnerable, crystals: engine.collectibles });
  for (let i = 0; i < 100; i++) engine.update(.05);
  assert.equal(JSON.stringify({ distance: engine.distance, time: engine.time, invulnerable: engine.invulnerable, crystals: engine.collectibles }), frozen);
  engine.resume();
  engine.invulnerable = 0; engine.obstacles = [hazard('bnb')]; engine.update(.05); assert.equal(engine.hearts, 1);
  engine.invulnerable = 0; engine.obstacles = [hazard('spike')]; engine.update(.05);
  assert.equal(engine.state, 'ended'); assert.equal(engine.result.reason, 'collision');
  assert.equal(engine.result.completed, false); assert.equal(engine.result.hearts, 0); assert.equal(engine.result.hits, 3);
});

check('weather and mud apply slowdown and break perfect runs without losing hearts', () => {
  for (const id of ['dai', 'gas']) {
    const events = [];
    const engine = running('level-5', seeded(5), name => events.push(name));
    engine.distance = 150; engine.speed = 20; engine.combo = 4; engine.obstacles = [hazard(id)];
    engine.update(.05);
    assert.equal(engine.hearts, 3); assert.equal(engine.hits, 1); assert.equal(engine.combo, 0);
    assert.equal(engine.state, 'running'); assert.ok(engine.slowRemaining > 0);
    assert.ok(events.includes('softHit')); assert.equal(events.includes('hit'), false);
    if (id === 'dai') assert.ok(engine.weather?.remaining > 0);
  }
});

check('ending-frame crystals are included before the end event and subsequent updates are inert', () => {
  const events = [];
  const engine = running('level-2', seeded(1), name => events.push(name));
  engine.distance = engine.rules.maxDistance - .2; engine.checkpoint = true; engine.nextSpawnDistance = Infinity;
  engine.speed = 20; engine.obstacles = []; engine.lane = 1; engine.visualLane = 1;
  engine.collectibles = [{ lane: 1, ahead: .2, distance: engine.rules.maxDistance, collected: false }];
  engine.update(.05);
  assert.equal(engine.result.completed, true); assert.equal(engine.result.crystals, 1); assert.equal(engine.result.totalCrystals, 1);
  assert.equal(engine.result.stars, 3); assert.ok(events.indexOf('collect') < events.indexOf('end'));
  const frozen = JSON.stringify(engine);
  for (let i = 0; i < 100; i++) engine.update(.05);
  assert.equal(JSON.stringify(engine), frozen, 'ended runs must not collect or change their summary');
});

check('star thresholds reward finishing, clean health and 75 percent crystal collection', () => {
  for (const [hits, crystals, expected] of [[2, 4, 1], [1, 4, 2], [0, 2, 2], [0, 3, 3], [0, 4, 3]]) {
    const engine = running('level-2');
    engine.distance = engine.rules.maxDistance; engine.hits = hits; engine.crystals = crystals;
    engine.collectibles = Array.from({ length: 4 }, (_, index) => ({ lane: 1, ahead: 10, collected: index < crystals }));
    engine.end('finish'); assert.equal(engine.result.stars, expected, `${hits} hits, ${crystals}/4 crystals`);
  }
});

console.log(JSON.stringify({ ok: true, passed: checks.length, simulations: 144, checks }, null, 2));
