import { OBSTACLES } from './config.js';
import { DEFAULT_RULES, normalizeRules, chooseOutcome, multiplierForDistance, payoutForDistance } from './rules.js';
import { difficultyAt, targetSpeed, obstacleRow } from './difficulty.js';
import { loadCatalog, validateCatalog } from './catalog.js';

const STATES = ['countdown', 'running', 'checkpoint', 'paused'];
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

// Local simulation; probability mode is disclosed in the rules and HUD.
export class RunnerEngine {
  constructor({ random = Math.random, onEvent = () => {}, rules = DEFAULT_RULES, catalog = loadCatalog() } = {}) {
    this.random = random; this.onEvent = onEvent; this.rules = normalizeRules(rules);
    this.catalog = validateCatalog(catalog);
    this.state = 'lobby'; this.distance = 0; this.lane = 1; this.visualLane = 1;
    this.obstacles = []; this.energy = 0; this.time = 0; this.speed = 0;
  }
  configure(rules, catalog = loadCatalog()) {
    if (!['lobby', 'ended'].includes(this.state)) return false;
    this.rules = normalizeRules(rules); this.catalog = validateCatalog(catalog); return true;
  }
  start(stake, { protectedRound = false } = {}) {
    const r = this.rules;
    if (!['lobby', 'ended'].includes(this.state) || !Number.isInteger(stake) || stake < r.minStake || stake > r.maxStake) return false;
    let outcome = r.mode === 'probability' ? chooseOutcome(this.random, r) : null;
    if (outcome?.multiplier === 0 && protectedRound) outcome = { key: 'breakEven', distance: r.breakevenDistance, multiplier: 1 };
    Object.assign(this, { stake, id: crypto.randomUUID(), state: 'countdown', countdown: 3, distance: 0,
      lane: 1, visualLane: 1, obstacles: [], taps: [], time: 0, speed: 0, energy: 0, nextSpawnDistance: r.firstSpawnDistance,
      checkpoint: false, floor: 0, result: null, safeLane: 1, lastTapAt: 0, lastMoveAt: -9, inputGraceUntil: r.inputGrace,
      stumbled: false, rocketActive: false, slowRemaining: 0, weather: null, effect: null, outcome,
      scriptedSpawned: false, protectedRound });
    this.onEvent('countdown', 3); return true;
  }
  tap() {
    if (this.state !== 'running') return;
    this.taps.push(this.time); this.lastTapAt = this.time;
    if (this.stumbled) { this.stumbled = false; this.onEvent('recover'); }
    this.onEvent('tap');
  }
  move(direction) {
    if (this.state !== 'running' || ![-1, 1].includes(direction)) return;
    const next = Math.max(0, Math.min(2, this.lane + direction));
    if (next !== this.lane) { this.lane = next; this.lastMoveAt = this.time; this.onEvent('move'); }
  }
  pause() {
    if (!['running', 'countdown'].includes(this.state)) return;
    this.resumeState = this.state; this.state = 'paused'; this.onEvent('pause');
  }
  resume() {
    if (this.state !== 'paused') return;
    this.state = this.resumeState; this.resetInput(); this.onEvent('resume');
  }
  resetInput() {
    this.taps = []; this.lastTapAt = this.time; this.stumbled = false; this.rocketActive = false;
    this.inputGraceUntil = this.time + this.rules.inputGrace;
  }
  continue() {
    if (this.state !== 'checkpoint') return;
    this.state = 'running'; this.floor = this.rules.lockFloorEnabled ? this.rules.floorMultiplier : 0; this.resetInput();
  }
  take() {
    if (['running', 'checkpoint'].includes(this.state) && this.distance >= this.rules.breakevenDistance) this.end('take');
  }
  impact(hazard) {
    this.effect = { kind: hazard?.impact || 'trip', obstacle: hazard?.id || 'eth', elapsed: 0, duration: .8 };
    this.onEvent('impact', hazard);
  }
  resultHazard() {
    const active = OBSTACLES.map(hazard => ({ ...hazard, ...this.catalog[hazard.id] }))
      .filter(hazard => hazard.enabled && hazard.weight > 0);
    return active.find(hazard => hazard.id === 'hole') || active[0];
  }
  end(reason, obstacle) {
    if (!['running', 'checkpoint'].includes(this.state)) return;
    if (reason === 'scheduled' && this.outcome) this.distance = this.outcome.distance;
    this.state = 'ended'; this.rocketActive = false;
    const mult = Math.max(this.floor, multiplierForDistance(this.distance, this.rules));
    if (!['take', 'finish'].includes(reason)) this.impact(obstacle || { id: 'eth', impact: 'trip' });
    this.result = { id: this.id, date: Date.now(), distance: Math.floor(this.distance), multiplier: mult,
      stake: this.stake, payout: Math.max(this.stake * this.floor, payoutForDistance(this.stake, this.distance, this.rules)),
      reason, mode: this.rules.mode, template: this.outcome?.key || null, protectedRound: this.protectedRound,
      obstacle: obstacle?.name || '', line: obstacle?.line || '', rules: this.rules };
    this.onEvent('end', this.result);
  }
  update(delta) {
    if (!Number.isFinite(delta) || delta <= 0) return;
    const dt = Math.min(delta, .05);
    if (this.effect && ['running', 'ended'].includes(this.state)) this.effect.elapsed = Math.min(this.effect.duration, this.effect.elapsed + dt);
    if (this.state === 'countdown') {
      const before = Math.ceil(this.countdown); this.countdown -= dt;
      if (Math.ceil(this.countdown) !== before) this.onEvent('countdown', Math.max(0, Math.ceil(this.countdown)));
      if (this.countdown <= 0) { this.state = 'running'; this.onEvent('go'); }
      return;
    }
    if (this.state !== 'running') return;
    const r = this.rules;
    this.time += dt; this.taps = this.taps.filter(t => t > this.time - 1);
    const gap = this.time - this.lastTapAt;
    if (r.continuousTapRequired && this.time > this.inputGraceUntil + 1e-8 && gap > r.tapTimeout + 1e-8) {
      const stumble = { id: 'eth', name: '加油断连', impact: 'trip', line: `连点中断超过 ${r.tapTimeout} 秒，闪避时也要继续加油！` };
      if (r.mode === 'skill') return this.end('stumble', stumble);
      if (!this.stumbled) { this.stumbled = true; this.impact(stumble); this.onEvent('stumble', stumble); }
    }
    this.visualLane += (this.lane - this.visualLane) * Math.min(1, dt * 16);
    const rate = this.taps.length;
    this.energy += (Math.min(1, rate / r.rocketTapRate) - this.energy) * Math.min(1, dt * 5);
    const rocket = rate >= r.rocketTapRate && !this.stumbled;
    if (rocket && !this.rocketActive) this.onEvent('rocket');
    this.rocketActive = rocket;
    this.slowRemaining = Math.max(0, this.slowRemaining - dt);
    if (this.weather) { this.weather.remaining -= dt; if (this.weather.remaining <= 0) this.weather = null; }
    const target = this.stumbled ? 0 : targetSpeed(this.distance, rate, r) * (this.slowRemaining > 0 ? .55 : 1);
    this.speed += (target - this.speed) * Math.min(1, dt * 4);
    if (this.stumbled && this.speed < .01) this.speed = 0;
    const old = this.distance;
    const endDistance = this.outcome?.distance ?? r.maxDistance;
    const boundary = !this.checkpoint && old < r.checkpointDistance && endDistance >= r.checkpointDistance
      ? r.checkpointDistance : endDistance;
    let travel = Math.min(Math.max(0, boundary - old), this.speed * dt), collision;
    for (const o of this.obstacles) {
      if (o.passed || Math.abs(this.visualLane - o.lane) >= .56) continue;
      const untilHit = Math.max(0, o.ahead - 1.5);
      if (untilHit <= travel) { travel = untilHit; collision = o; }
    }
    this.distance = old + travel;
    for (const o of this.obstacles) o.ahead -= travel;
    if (collision) {
      if (collision.scripted && !this.checkpoint && this.distance >= r.checkpointDistance) {
        this.checkpoint = true; this.state = 'checkpoint'; this.rocketActive = false; this.onEvent('checkpoint'); return;
      }
      if (collision.scripted) return this.end('scheduled', collision);
      if (r.mode === 'skill' && !['slow', 'weather'].includes(collision.behavior)) return this.end('collision', collision);
      collision.passed = true; this.impact(collision);
      this.slowRemaining = collision.slowDuration || .65;
      if (collision.behavior === 'weather') {
        this.weather = { id: collision.id, remaining: 2, total: 2 }; this.onEvent('weather', collision);
      }
    }
    for (const o of this.obstacles) {
      // 闪避判定必须等障碍完全离开碰撞体积（过身 1.5 米）。若在 1.5 米线
      // 就标记 passed，换道动画中的角色随后滑进其车道也不会再判碰撞，
      // 表现为"明明撞上方块却穿过去了"。
      if (!o.passed && o.ahead <= -1.5) { o.passed = true; this.onEvent('dodge', o); }
    }
    this.obstacles = this.obstacles.filter(o => o.ahead > -8);
    if (!this.checkpoint && this.distance >= r.checkpointDistance) {
      this.checkpoint = true; this.state = 'checkpoint'; this.rocketActive = false; this.onEvent('checkpoint'); return;
    }
    if (this.distance >= endDistance) return this.end(endDistance >= r.maxDistance ? 'finish' : 'scheduled',
      this.resultHazard());
    if (this.outcome && !this.scriptedSpawned && endDistance < r.maxDistance && endDistance - this.distance <= r.warningDistance) {
      const hazard = this.resultHazard();
      for (let lane = 0; lane < 3; lane++) this.obstacles.push({ ...hazard, lane, ahead: endDistance - this.distance + 1.5,
        warningDistance: r.warningDistance, passed: false, scripted: true, name: '本局结果区',
        line: '已到达本局抽取的结果区，按公开的概率模式规则结算。' });
      this.scriptedSpawned = true; this.onEvent('scheduledWarning');
    }
    while (this.distance >= this.nextSpawnDistance) {
      const spawnDistance = this.nextSpawnDistance;
      const row = obstacleRow(this.random, spawnDistance, this.safeLane, r, this.catalog);
      for (const o of row.obstacles) { o.ahead -= this.distance - spawnDistance; this.onEvent('warning', o); }
      this.obstacles.push(...row.obstacles); this.safeLane = row.safeLane;
      this.nextSpawnDistance += difficultyAt(spawnDistance, r).rowSpacing + this.random() * 2;
    }
  }
  snapshot() {
    return JSON.parse(JSON.stringify({ version: 3, rules: this.rules, catalog: this.catalog, id: this.id, stake: this.stake,
      state: this.state, resumeState: this.resumeState, countdown: this.countdown, distance: this.distance,
      lane: this.lane, visualLane: this.visualLane, obstacles: this.obstacles, time: this.time, speed: this.speed,
      energy: this.energy, nextSpawnDistance: this.nextSpawnDistance, checkpoint: this.checkpoint, floor: this.floor,
      safeLane: this.safeLane, outcome: this.outcome, scriptedSpawned: this.scriptedSpawned, protectedRound: this.protectedRound }));
  }
  restore(snapshot) {
    try {
      if (!snapshot || snapshot.version !== 3 || !STATES.includes(snapshot.state) || typeof snapshot.id !== 'string' || snapshot.id.length > 100) return false;
      const r = normalizeRules(snapshot.rules);
      const catalog = validateCatalog(snapshot.catalog || {});
      if (!finite(snapshot.stake, r.minStake, r.maxStake) || !Number.isInteger(snapshot.stake) || !finite(snapshot.distance, 0, r.maxDistance)
        || !finite(snapshot.time, 0, 1e7) || !finite(snapshot.speed, 0, r.rocketSpeed + 1) || ![0, 1, 2].includes(snapshot.lane)
        || !finite(snapshot.visualLane, 0, 2) || !finite(snapshot.nextSpawnDistance, 0, r.maxDistance + 100)
        || !finite(snapshot.energy, 0, 1) || !finite(snapshot.countdown, -.05, 3) || ![0, 1, 2].includes(snapshot.safeLane)
        || !finite(snapshot.floor, 0, r.floorMultiplier)
        || typeof snapshot.checkpoint !== 'boolean' || typeof snapshot.scriptedSpawned !== 'boolean' || typeof snapshot.protectedRound !== 'boolean'
        || (snapshot.state === 'paused' && !['countdown', 'running'].includes(snapshot.resumeState))
        || (snapshot.checkpoint && snapshot.distance < r.checkpointDistance)
        || (!snapshot.checkpoint && snapshot.distance >= r.checkpointDistance)
        || (snapshot.state === 'checkpoint' && snapshot.distance !== r.checkpointDistance)
        || (!snapshot.checkpoint && snapshot.floor !== 0)
        || !Array.isArray(snapshot.obstacles) || snapshot.obstacles.length > 80) return false;
      if (r.mode === 'probability' && (!snapshot.outcome || !finite(snapshot.outcome.distance, snapshot.distance, r.maxDistance)
        || snapshot.outcome.multiplier !== multiplierForDistance(snapshot.outcome.distance, r))) return false;
      if (r.mode === 'probability') {
        const m = snapshot.outcome.multiplier;
        const key = m === 0 ? 'loss' : m === 1 ? 'breakEven' : m < 2 ? 'smallWin' : m === 2 ? 'double' : 'highWin';
        if (snapshot.outcome.key !== key) return false;
      }
      const obstacles = snapshot.obstacles.map(o => {
        const hazard = OBSTACLES.find(h => h.id === o.id);
        if (!hazard || ![0, 1, 2].includes(o.lane) || !finite(o.ahead, -8, r.warningDistance + 10)) throw new Error('Invalid saved obstacle');
        return { ...hazard, ...catalog[hazard.id], lane: o.lane, ahead: o.ahead, passed: !!o.passed, scripted: !!o.scripted,
          warningDistance: r.warningDistance, ...(o.scripted ? { name: '本局结果区', line: '已到达本局抽取的结果区。' } : {}) };
      });
      this.rules = r; this.catalog = catalog; this.state = 'lobby'; this.start(snapshot.stake);
      const fields = ['id', 'stake', 'countdown', 'distance', 'lane', 'visualLane', 'time', 'speed', 'energy',
        'nextSpawnDistance', 'checkpoint', 'safeLane', 'scriptedSpawned', 'protectedRound'];
      for (const field of fields) this[field] = snapshot[field];
      this.outcome = r.mode === 'probability' ? { ...snapshot.outcome } : null; this.obstacles = obstacles;
      this.floor = r.lockFloorEnabled && snapshot.checkpoint ? Math.min(r.floorMultiplier, Number(snapshot.floor) || 0) : 0;
      const previous = snapshot.state === 'paused' ? snapshot.resumeState : snapshot.state;
      this.resumeState = ['countdown', 'running'].includes(previous) ? previous : 'running';
      this.state = previous === 'checkpoint' ? 'checkpoint' : 'paused'; this.resetInput();
      return true;
    } catch { return false; }
  }
}
