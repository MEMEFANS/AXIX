import { CONFIG } from './config.js?v=20261028c';

const KEY = 'run-aix:practice:v1';
const MAX_BALANCE = 1e9;
const DEFAULT_RULES = Object.freeze({
  initialCredits: CONFIG.initialCredits, minStake: CONFIG.minStake, maxStake: CONFIG.maxStake,
  burnPercent: 100, platformPercent: 0, activityPercent: 0,
  consolationPerPoint: 1, consolationDailyCap: 1000,
  lotteryCost: 10, lotteryDailyLimit: 20, roundCooldown: 0, dailyRoundLimit: 0,
});
// 固定公示的本机模拟奖品。安慰积分只能用于这里，不可兑换或转出。
const PRIZES = Object.freeze([
  Object.freeze({ id: 'thanks', name: '谢谢参与', probability: 0.6, type: 'none', amount: 0 }),
  Object.freeze({ id: 'practice-5', name: '5 试玩积分', probability: 0.25, type: 'credits', amount: 5 }),
  Object.freeze({ id: 'practice-20', name: '20 试玩积分', probability: 0.1, type: 'credits', amount: 20 }),
  Object.freeze({ id: 'starlight', name: '星光装扮（本机收藏）', probability: 0.05, type: 'cosmetic', amount: 0 }),
]);

// 与可配置收益曲线保持六位精度，默认 0.1 倍曲线仍显示为一位。
const round = value => Math.round((value + Number.EPSILON) * 1e6) / 1e6;
const money = value => Number.isFinite(value) && value >= 0 && value <= MAX_BALANCE;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 160;
const count = value => Number.isSafeInteger(value) && value >= 0;
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
function browserStorage() { try { return globalThis.localStorage; } catch { return null; } }
export function chinaDay(date = Date.now()) {
  return new Date(date + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function cleanRules(input = {}) {
  const result = { ...DEFAULT_RULES };
  for (const key of Object.keys(result)) {
    const value = input?.[key];
    if (Number.isFinite(value) && value >= 0 && value <= MAX_BALANCE) result[key] = value;
  }
  for (const key of ['initialCredits', 'minStake', 'maxStake', 'consolationDailyCap', 'lotteryCost', 'lotteryDailyLimit', 'dailyRoundLimit']) result[key] = Math.floor(result[key]);
  result.minStake = Math.max(1, result.minStake);
  result.maxStake = Math.max(result.minStake, result.maxStake);
  result.lotteryCost = Math.max(1, result.lotteryCost);
  if (Math.abs(result.burnPercent + result.platformPercent + result.activityPercent - 100) > 1e-6) {
    result.burnPercent = 100; result.platformPercent = result.activityPercent = 0;
  }
  return result;
}
function cleanRecord(value, fallbackStake) {
  if (!value || typeof value !== 'object' || !identifier(value.id)) return null;
  const stake = value.stake ?? fallbackStake;
  if (!Number.isInteger(stake) || stake < 1 || stake > MAX_BALANCE || !money(value.payout)) return null;
  if (!Number.isFinite(value.date) || value.date <= 0 || value.date > 8.64e15 - 864e5) return null;
  // 绝对上限与规则编辑器一致；历史记录可来自之前的另一套已校验规则。
  if (!Number.isFinite(value.distance) || value.distance < 0 || value.distance > 2000) return null;
  if (!Number.isFinite(value.multiplier) || value.multiplier < 0 || value.multiplier > 10) return null;
  if (Math.abs(value.payout - round(stake * value.multiplier)) > 0.000001) return null;
  if (value.reason != null && (typeof value.reason !== 'string' || value.reason.length > 100)) return null;
  const record = { id: value.id, stake, payout: round(value.payout), date: value.date,
    distance: value.distance, multiplier: value.multiplier, reason: value.reason || 'complete' };
  for (const key of ['line', 'obstacle', 'mode', 'outcomeId', 'outcomeLabel']) if (typeof value[key] === 'string') record[key] = value[key].slice(0, 500);
  for (const key of ['consolationAwarded', 'simulatedBurned', 'simulatedPlatform', 'simulatedActivity']) if (money(value[key])) record[key] = value[key];
  return record;
}
function snapshotCopy(snapshot, pending) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  try {
    const text = JSON.stringify(snapshot);
    if (text.length > 100000 || (snapshot.id != null && snapshot.id !== pending.id) || (snapshot.stake != null && snapshot.stake !== pending.stake)) return null;
    return JSON.parse(text);
  } catch { return null; }
}
const compareRuns = (a, b) => b.distance - a.distance || b.multiplier - a.multiplier || b.payout - a.payout || a.date - b.date;
const topRuns = records => [...records].sort(compareRuns).slice(0, 20);

// 仅本浏览器模拟账本。永不读取钱包、请求资产 API 或产生链上交易。
export class PracticeStore {
  constructor(storage = browserStorage(), rules) {
    this.storage = storage; this.rules = cleanRules(rules); this.storageAvailable = false;
    this.data = this.freshData(); this._serialized = null;
    this.refresh();
  }
  freshData() {
    return { version: 3, credits: this.rules.initialCredits, consolation: 0, records: [],
      pending: null, settledIds: [], draws: [], cosmetics: [], lastRoundAt: 0,
      daily: { day: chinaDay(), rounds: 0, draws: 0, consolationEarned: 0 },
      leaderboard: { dailyDay: chinaDay(), daily: [], all: [] },
      economy: { spent: 0, paid: 0, burned: 0, platform: 0, activity: 0 },
      totalRounds: 0 };
  }
  setRules(rules) { this.rules = cleanRules(rules); return { ...this.rules }; }
  decode(value) {
    if (!value || typeof value !== 'object' || !money(value.credits) || !Array.isArray(value.records)) return null;
    const result = this.freshData(); result.credits = round(value.credits);
    result.records = value.records.map(record => cleanRecord(record)).filter(Boolean).slice(0, 20);
    if (money(value.consolation)) result.consolation = round(value.consolation);
    result.settledIds = [...new Set([...(Array.isArray(value.settledIds) ? value.settledIds.filter(identifier) : []), ...result.records.map(record => record.id)])];
    result.draws = (Array.isArray(value.draws) ? value.draws : []).filter(draw => draw && identifier(draw.id) && Number.isFinite(draw.date) && PRIZES.some(prize => prize.id === draw.prizeId) && money(draw.cost)).map(draw => {
      const prize = PRIZES.find(item => item.id === draw.prizeId);
      return { id: draw.id, date: draw.date, cost: draw.cost, prizeId: prize.id, prize: { ...prize } };
    });
    result.cosmetics = [...new Set((Array.isArray(value.cosmetics) ? value.cosmetics : []).filter(id => PRIZES.some(prize => prize.id === id && prize.type === 'cosmetic')))];
    if (Number.isFinite(value.lastRoundAt) && value.lastRoundAt >= 0) result.lastRoundAt = value.lastRoundAt;
    if (count(value.totalRounds)) result.totalRounds = value.totalRounds;
    else result.totalRounds = result.records.length;
    const daily = value.daily;
    if (daily && /^\d{4}-\d{2}-\d{2}$/.test(daily.day) && count(daily.rounds) && count(daily.draws) && money(daily.consolationEarned)) result.daily = { day: daily.day, rounds: daily.rounds, draws: daily.draws, consolationEarned: daily.consolationEarned };
    for (const key of Object.keys(result.economy)) if (money(value.economy?.[key])) result.economy[key] = value.economy[key];
    const leaderboard = value.leaderboard;
    result.leaderboard.all = topRuns((Array.isArray(leaderboard?.all) ? leaderboard.all : result.records).map(record => cleanRecord(record)).filter(Boolean));
    result.leaderboard.dailyDay = /^\d{4}-\d{2}-\d{2}$/.test(leaderboard?.dailyDay) ? leaderboard.dailyDay : chinaDay();
    result.leaderboard.daily = topRuns((Array.isArray(leaderboard?.daily) ? leaderboard.daily : result.records).map(record => cleanRecord(record)).filter(record => record && chinaDay(record.date) === result.leaderboard.dailyDay));
    const pending = value.pending;
    if (pending && (identifier(pending.id) || (pending.id === null && pending.legacy === true)) && Number.isInteger(pending.stake) && pending.stake >= 1 && pending.stake <= MAX_BALANCE && Number.isFinite(pending.date) && pending.date > 0 && !result.settledIds.includes(pending.id)) {
      result.pending = { id: pending.id, stake: pending.stake, date: pending.date, legacy: pending.legacy === true };
      const snapshot = snapshotCopy(pending.snapshot, result.pending);
      if (snapshot) result.pending.snapshot = snapshot;
    }
    return result;
  }
  refresh() {
    try {
      const serialized = this.storage?.getItem(KEY);
      if (serialized && serialized !== this._serialized) {
        const value = this.decode(JSON.parse(serialized));
        if (value) { this.data = value; this._serialized = serialized; }
      }
    } catch { /* 存档损坏或浏览器禁用存储时保留当前内存状态。 */ }
    this.rollDay();
  }
  rollDay() {
    const day = chinaDay();
    if (this.data.daily.day !== day) this.data.daily = { day, rounds: 0, draws: 0, consolationEarned: 0 };
    if (this.data.leaderboard.dailyDay !== day) this.data.leaderboard = { ...this.data.leaderboard, dailyDay: day, daily: [] };
  }
  save() {
    try {
      if (!this.storage?.setItem) throw new Error('storage unavailable');
      const serialized = JSON.stringify(this.data);
      this.storage.setItem(KEY, serialized); this._serialized = serialized; this.storageAvailable = true; return true;
    } catch { this.storageAvailable = false; return false; }
  }
  getDailyStatus() {
    this.refresh(); const daily = this.data.daily;
    return { ...daily, remainingRounds: this.rules.dailyRoundLimit ? Math.max(0, this.rules.dailyRoundLimit - daily.rounds) : Infinity,
      remainingDraws: Math.max(0, this.rules.lotteryDailyLimit - daily.draws),
      remainingConsolation: Math.max(0, this.rules.consolationDailyCap - daily.consolationEarned),
      cooldownMs: Math.max(0, this.data.lastRoundAt + this.rules.roundCooldown * 1000 - Date.now()) };
  }
  beginRound(stake, id, snapshot) {
    this.refresh();
    if (!identifier(id)) return { ok: false, error: 'invalid-id' };
    if (this.data.pending?.id === id && this.data.pending.stake === stake) return { ok: true, pending: this.recoverPending(), replayed: true };
    if (this.data.settledIds.includes(id)) return { ok: false, error: 'already-settled' };
    return this.startRound(stake, id, snapshot);
  }
  startRound(stake, id, snapshot, legacy = false) {
    if (this.data.pending) return { ok: false, error: 'pending-round' };
    if (!Number.isInteger(stake) || stake < this.rules.minStake || stake > this.rules.maxStake) return { ok: false, error: 'invalid-stake' };
    if (stake > this.data.credits) return { ok: false, error: 'insufficient-credits' };
    const status = this.getDailyStatus();
    if (status.remainingRounds <= 0) return { ok: false, error: 'daily-limit' };
    if (status.cooldownMs > 0) return { ok: false, error: 'cooldown' };
    const pending = { id, stake, date: Date.now(), legacy };
    if (snapshot != null) {
      const clean = snapshotCopy(snapshot, pending);
      if (!clean) return { ok: false, error: 'invalid-snapshot' };
      pending.snapshot = clean;
    }
    this.data.credits = round(this.data.credits - stake); this.data.pending = pending;
    this.data.daily.rounds++; this.data.totalRounds++; this.data.lastRoundAt = pending.date;
    this.data.economy.spent = round(this.data.economy.spent + stake);
    this.save(); return { ok: true, pending: copy(pending) };
  }
  // 旧版 spend 不知道随后生成的 engine.id，首次合法 settle 时绑定该 ID。
  spend(stake) { this.refresh(); return this.startRound(stake, null, undefined, true).ok; }
  checkpointRound(snapshot) {
    this.refresh(); if (!this.data.pending) return false;
    const clean = snapshotCopy(snapshot, this.data.pending); if (!clean) return false;
    this.data.pending.snapshot = clean; this.save(); return true;
  }
  recoverPending() { this.refresh(); return copy(this.data.pending); }
  settle(value) {
    this.refresh(); const pending = this.data.pending;
    if (!pending || !value || this.data.settledIds.includes(value.id)) return false;
    if (!pending.legacy && pending.id !== value.id) return false;
    const record = cleanRecord(value, pending.stake);
    if (!record || record.stake !== pending.stake || record.date < pending.date - 1000 || record.date > Date.now() + 60000 || this.data.credits + record.payout > MAX_BALANCE) return false;
    // 中途作废永不返还、永不发安慰积分。
    if (record.reason === 'abort' && (record.payout !== 0 || record.multiplier !== 0)) return false;
    const fullLoss = record.multiplier === 0 && record.reason !== 'abort';
    record.consolationAwarded = fullLoss ? Math.min(round(record.stake * this.rules.consolationPerPoint), this.getDailyStatus().remainingConsolation, MAX_BALANCE - this.data.consolation) : 0;
    const loss = Math.max(0, record.stake - record.payout);
    record.simulatedBurned = round(loss * this.rules.burnPercent / 100);
    record.simulatedPlatform = Math.min(round(loss * this.rules.platformPercent / 100), round(loss - record.simulatedBurned));
    record.simulatedActivity = round(loss - record.simulatedBurned - record.simulatedPlatform);
    this.data.credits = round(this.data.credits + record.payout);
    this.data.consolation = round(this.data.consolation + record.consolationAwarded);
    this.data.daily.consolationEarned = round(this.data.daily.consolationEarned + record.consolationAwarded);
    this.data.economy.paid = round(this.data.economy.paid + record.payout);
    this.data.economy.burned = round(this.data.economy.burned + record.simulatedBurned);
    this.data.economy.platform = round(this.data.economy.platform + record.simulatedPlatform);
    this.data.economy.activity = round(this.data.economy.activity + record.simulatedActivity);
    this.data.settledIds.push(record.id); this.data.pending = null;
    this.data.records.unshift(record); this.data.records.length = Math.min(20, this.data.records.length);
    if (record.reason !== 'abort') {
      this.data.leaderboard.all = topRuns([...this.data.leaderboard.all, record]);
      if (chinaDay(record.date) === this.data.daily.day) this.data.leaderboard.daily = topRuns([...this.data.leaderboard.daily, record]);
    }
    this.save(); return true;
  }
  abortPending() {
    const pending = this.recoverPending(); if (!pending) return false;
    const id = pending.id || `aborted-${pending.date}-${this.data.totalRounds}`;
    return this.settle({ id, stake: pending.stake, date: Date.now(), distance: 0, multiplier: 0, payout: 0, reason: 'abort' });
  }
  refill() {
    this.refresh(); if (this.data.pending) return false;
    this.data.credits = this.rules.initialCredits; this.save(); return true;
  }
  lotteryPrizes() { return PRIZES.map(prize => ({ ...prize })); }
  draw(id, random = Math.random) {
    this.refresh(); if (!identifier(id)) return { ok: false, error: 'invalid-id' };
    const existing = this.data.draws.find(draw => draw.id === id);
    if (existing) return { ok: true, draw: copy(existing), replayed: true };
    if (this.getDailyStatus().remainingDraws <= 0) return { ok: false, error: 'daily-limit' };
    if (this.data.consolation < this.rules.lotteryCost) return { ok: false, error: 'insufficient-consolation' };
    let value; try { value = typeof random === 'function' ? random() : random; } catch { return { ok: false, error: 'invalid-random' }; }
    if (!Number.isFinite(value) || value < 0 || value >= 1) return { ok: false, error: 'invalid-random' };
    let cumulative = 0;
    const prize = PRIZES.find(item => { cumulative += item.probability; return value < cumulative; }) || PRIZES.at(-1);
    if (prize.type === 'credits' && this.data.credits + prize.amount > MAX_BALANCE) return { ok: false, error: 'credit-limit' };
    const draw = { id, date: Date.now(), cost: this.rules.lotteryCost, prizeId: prize.id, prize: { ...prize } };
    this.data.consolation = round(this.data.consolation - draw.cost); this.data.daily.draws++;
    if (prize.type === 'credits') this.data.credits = round(this.data.credits + prize.amount);
    if (prize.type === 'cosmetic' && !this.data.cosmetics.includes(prize.id)) this.data.cosmetics.push(prize.id);
    this.data.draws.unshift(draw); this.save(); return { ok: true, draw: copy(draw), replayed: false };
  }
  getLeaderboard(period = 'daily') {
    this.refresh(); return copy(period === 'all' ? this.data.leaderboard.all : this.data.leaderboard.daily);
  }
}
