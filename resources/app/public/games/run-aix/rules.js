// V3 本机试玩规则。此模块不连接钱包、服务器或真实 AIX 余额。
export const RULES_STORAGE_KEY = 'run-aix:v3:rules';
export const RULES_VERSION = 3;
export const DEFAULT_RULES = Object.freeze({
  mode: 'probability',
  minStake: 1, maxStake: 100, initialCredits: 1000,
  maxDistance: 500, breakevenDistance: 100, checkpointDistance: 200,
  stepDistance: 10, stepMultiplier: 0.1, maxMultiplier: 5,
  lockFloorEnabled: true, floorMultiplier: 2,
  baseSpeed: 18, maxSpeed: 42, rocketSpeed: 56, rocketTapRate: 7,
  speedCurve: .85, speedStep: 0,
  tapTimeout: 0.2, inputGrace: 1, continuousTapRequired: true,
  warningDistance: 56, firstSpawnDistance: 8,
  rowSpacingStart: 24, rowSpacingEnd: 17,
  doubleChanceStart: 0.5, doubleChanceEnd: 0.95,
  changeChanceStart: 0.75, changeChanceEnd: 0.95,
  lossWeight: 60, breakEvenWeight: 15, smallWinWeight: 18, doubleWeight: 6, highWinWeight: 1,
  burnPercent: 100, platformPercent: 0, activityPercent: 0,
  consolationPerPoint: 1, consolationDailyCap: 1000, lotteryCost: 10, lotteryDailyLimit: 20,
  newUserProtectionRounds: 0, roundCooldown: 0, dailyRoundLimit: 0,
});

export const RULE_LIMITS = Object.freeze({
  minStake: [1, 10000, true], maxStake: [1, 10000, true], initialCredits: [100, 1000000, true],
  maxDistance: [200, 2000, true], breakevenDistance: [40, 300, true], checkpointDistance: [80, 1000, true],
  stepDistance: [1, 50, true], stepMultiplier: [0.05, 0.5], maxMultiplier: [2.1, 10], floorMultiplier: [1, 2],
  baseSpeed: [8, 160], maxSpeed: [12, 160], rocketSpeed: [18, 180], rocketTapRate: [3, 12],
  speedCurve: [.5, 2], speedStep: [0, 100],
  tapTimeout: [0.15, 1], inputGrace: [0.5, 5], warningDistance: [30, 220], firstSpawnDistance: [0, 60],
  rowSpacingStart: [14, 120], rowSpacingEnd: [12, 110],
  doubleChanceStart: [0, 1], doubleChanceEnd: [0, 1], changeChanceStart: [0, 1], changeChanceEnd: [0, 1],
  lossWeight: [0, 100], breakEvenWeight: [0, 100], smallWinWeight: [0, 100], doubleWeight: [0, 100], highWinWeight: [0, 100],
  burnPercent: [0, 100], platformPercent: [0, 100], activityPercent: [0, 100],
  consolationPerPoint: [0, 10], consolationDailyCap: [0, 100000, true], lotteryCost: [1, 1000, true],
  lotteryDailyLimit: [0, 200, true], newUserProtectionRounds: [0, 20, true],
  roundCooldown: [0, 3600, true], dailyRoundLimit: [0, 1000, true],
});

const WEIGHTS = ['lossWeight', 'breakEvenWeight', 'smallWinWeight', 'doubleWeight', 'highWinWeight'];
const OUTCOMES = ['loss', 'breakEven', 'smallWin', 'double', 'highWin'];
const close = (a, b) => Math.abs(a - b) < 1e-7;
const round = n => Math.round(n * 1000000) / 1000000;

export function normalizeRules(input = {}) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('规则必须是对象。');
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_RULES, key)) errors.push(`不支持的设置：${key}`);
  const rules = { ...DEFAULT_RULES, ...input };
  if (!['probability', 'skill'].includes(rules.mode)) errors.push('玩法模式必须是 probability 或 skill。');
  for (const key of ['lockFloorEnabled', 'continuousTapRequired']) if (typeof rules[key] !== 'boolean') errors.push(`${key} 必须是开关值。`);
  for (const [key, [min, max, integer]] of Object.entries(RULE_LIMITS)) {
    const value = rules[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) errors.push(`${key} 范围为 ${min}–${max}${integer ? '，必须为整数' : ''}。`);
  }
  if (!errors.length) {
    if (rules.minStake > rules.maxStake) errors.push('最低门槛不能高于最高门槛。');
    if (rules.initialCredits < rules.maxStake) errors.push('初始试玩积分不能低于最高门槛。');
    if (!(rules.breakevenDistance < rules.checkpointDistance && rules.checkpointDistance < rules.maxDistance)) errors.push('距离须满足：保本线 < 翻倍线 < 最远距离。');
    const checkpointMultiplier = 1 + ((rules.checkpointDistance - rules.breakevenDistance) / rules.stepDistance) * rules.stepMultiplier;
    const finalMultiplier = 1 + ((rules.maxDistance - rules.breakevenDistance) / rules.stepDistance) * rules.stepMultiplier;
    if (!Number.isInteger((rules.checkpointDistance - rules.breakevenDistance) / rules.stepDistance) || !close(checkpointMultiplier, 2)) errors.push('翻倍线必须落在收益步长上，且按收益曲线恰为 2.0 倍。');
    if (!Number.isInteger((rules.maxDistance - rules.breakevenDistance) / rules.stepDistance) || !close(finalMultiplier, rules.maxMultiplier)) errors.push('最远距离必须落在收益步长上，且按收益曲线恰好达到最高倍率。');
    if (!(rules.baseSpeed <= rules.maxSpeed && rules.maxSpeed <= rules.rocketSpeed)) errors.push('速度须满足：正常速度 ≤ 连点最高速度 ≤ 火箭速度。');
    if (rules.warningDistance < rules.rocketSpeed * 0.55) errors.push('预警距离至少须留出 0.55 秒的火箭速度反应时间。');
    if (rules.rowSpacingEnd > rules.rowSpacingStart) errors.push('后期障碍行距不能大于前期行距。');
    if (rules.doubleChanceEnd < rules.doubleChanceStart || rules.changeChanceEnd < rules.changeChanceStart) errors.push('后期双障碍与换道概率不能低于前期。');
    if (!close(WEIGHTS.reduce((sum, key) => sum + rules[key], 0), 100)) errors.push('五档结果概率之和必须为 100%。');
    if (!close(rules.burnPercent + rules.platformPercent + rules.activityPercent, 100)) errors.push('销毁、平台、活动分配之和必须为 100%。');
  }
  if (errors.length) {
    const error = new RangeError(errors.join('\n'));
    error.errors = errors;
    throw error;
  }
  return Object.freeze(rules);
}

export function multiplierForDistance(distance, rules = DEFAULT_RULES) {
  if (!Number.isFinite(distance) || distance < rules.breakevenDistance) return 0;
  const steps = Math.floor((Math.min(distance, rules.maxDistance) - rules.breakevenDistance + 1e-8) / rules.stepDistance);
  return round(Math.min(rules.maxMultiplier, 1 + steps * rules.stepMultiplier));
}

export function payoutForDistance(stake, distance, rules = DEFAULT_RULES) {
  return round(stake * multiplierForDistance(distance, rules));
}

function storageOrDefault(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage; } catch { return null; }
}

function readEnvelope(storage) {
  try {
    const value = JSON.parse(storageOrDefault(storage)?.getItem(RULES_STORAGE_KEY) || 'null');
    if (!value || value.version !== RULES_VERSION || !Number.isSafeInteger(value.revision) || value.revision < 1) return null;
    return { ...value, rules: normalizeRules(value.rules) };
  } catch { return null; }
}

// 每局开始读取一次。进行中的游戏应持有此返回对象，避免中途参数变化。
export function loadRules(storage) {
  return readEnvelope(storage)?.rules || DEFAULT_RULES;
}

export function loadRulesHistory(storage) {
  const current = readEnvelope(storage);
  if (!current) return [];
  const all = [...(Array.isArray(current.history) ? current.history : []), { revision: current.revision, updatedAt: current.updatedAt, action: current.action || 'save', rules: current.rules }];
  return all.flatMap(entry => {
    try { return [{ ...entry, rules: normalizeRules(entry.rules) }]; } catch { return []; }
  }).reverse();
}

function persist(input, storage, action) {
  const rules = normalizeRules(input);
  const target = storageOrDefault(storage);
  if (!target || typeof target.setItem !== 'function') throw new Error('浏览器不允许保存本机规则，请启用网站存储后重试。');
  const old = readEnvelope(target);
  const history = old ? [...(Array.isArray(old.history) ? old.history : []), { revision: old.revision, updatedAt: old.updatedAt, action: old.action || 'save', rules: old.rules }].slice(-29) : [];
  const envelope = { version: RULES_VERSION, revision: (old?.revision || 0) + 1, updatedAt: new Date().toISOString(), action, rules, history };
  try { target.setItem(RULES_STORAGE_KEY, JSON.stringify(envelope)); } catch { throw new Error('本机规则保存失败，可能是浏览器存储空间不足。'); }
  return envelope;
}

export function saveRules(input, storage) { return persist(input, storage, 'save'); }
export function resetRules(storage) { return persist(DEFAULT_RULES, storage, 'reset'); }
export function rollbackRules(revision, storage) {
  const old = loadRulesHistory(storage).find(item => item.revision === Number(revision));
  if (!old) throw new Error('未找到这次修改；本机仅保留最近 30 个版本。');
  return persist(old.rules, storage, `rollback:${old.revision}`);
}

function draw(random) {
  const value = random();
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError('随机源须返回 [0, 1) 范围的有限数值。');
  return value;
}

function outcomeBuckets(rules) {
  const buckets = { loss: [], breakEven: [], smallWin: [], double: [], highWin: [] };
  // 全损、保本可落在整数米；收益档严格落在配置步长上。
  for (let distance = Math.min(20, rules.breakevenDistance - 1); distance < rules.breakevenDistance; distance++) buckets.loss.push(distance);
  for (let offset = 0; offset < rules.stepDistance; offset++) buckets.breakEven.push(rules.breakevenDistance + offset);
  for (let distance = rules.breakevenDistance + rules.stepDistance; distance <= rules.maxDistance; distance += rules.stepDistance) {
    const multiplier = multiplierForDistance(distance, rules);
    const key = multiplier < 2 ? 'smallWin' : close(multiplier, 2) ? 'double' : 'highWin';
    buckets[key].push(distance);
  }
  return buckets;
}

function selectOutcome(random, rules, buckets) {
  const ticket = draw(random) * 100;
  let ceiling = 0;
  let index = OUTCOMES.length - 1;
  for (let i = 0; i < WEIGHTS.length; i++) { ceiling += rules[WEIGHTS[i]]; if (ticket < ceiling) { index = i; break; } }
  const key = OUTCOMES[index];
  const distances = buckets[key];
  if (!distances.length) throw new RangeError(`收益曲线缺少 ${key} 结果档。`);
  const distance = distances[Math.floor(draw(random) * distances.length)];
  return { key, multiplier: multiplierForDistance(distance, rules), distance };
}

export function chooseOutcome(random = Math.random, rules = DEFAULT_RULES) {
  const normalized = normalizeRules(rules);
  return selectOutcome(random, normalized, outcomeBuckets(normalized));
}

export function simulateRules(input = DEFAULT_RULES, rounds = 10000, random = Math.random) {
  const rules = normalizeRules(input);
  if (!Number.isSafeInteger(rounds) || rounds < 10000 || rounds > 1000000) throw new RangeError('试算局数须为 10,000–1,000,000 的整数。');
  const buckets = outcomeBuckets(rules);
  const bands = Object.fromEntries(OUTCOMES.map((key, index) => [key, { count: 0, percent: 0, configuredPercent: rules[WEIGHTS[index]], returnUnits: 0 }]));
  let returnUnits = 0, peakCount = 0, distanceSum = 0;
  for (let i = 0; i < rounds; i++) {
    const outcome = selectOutcome(random, rules, buckets);
    bands[outcome.key].count++;
    bands[outcome.key].returnUnits += outcome.multiplier;
    returnUnits += outcome.multiplier;
    distanceSum += outcome.distance;
    if (close(outcome.multiplier, rules.maxMultiplier)) peakCount++;
  }
  let theoreticalReturnRate = 0;
  for (let i = 0; i < OUTCOMES.length; i++) {
    const key = OUTCOMES[i], distances = buckets[key];
    bands[key].percent = bands[key].count / rounds * 100;
    theoreticalReturnRate += rules[WEIGHTS[i]] / 100 * distances.reduce((sum, distance) => sum + multiplierForDistance(distance, rules), 0) / distances.length;
  }
  const losses = bands.loss.count;
  const wins = bands.smallWin.count + bands.double.count + bands.highWin.count;
  return {
    kind: 'outcome-template', mode: rules.mode, rounds, stakePerRound: 1,
    note: '每局按 1 试玩积分等额试算系统结果模板；不含玩家碰撞、断连、提前带走、每日限制或新手保护的影响。',
    returnRate: returnUnits / rounds, theoreticalReturnRate, returnUnits, consumedUnits: rounds,
    lossCount: losses, breakEvenCount: bands.breakEven.count, winCount: wins,
    lossPercent: losses / rounds * 100, breakEvenPercent: bands.breakEven.percent, winPercent: wins / rounds * 100,
    meanDistance: distanceSum / rounds, peakCount, peakPercent: peakCount / rounds * 100,
    bands,
    distribution: { lossUnits: losses, burnUnits: losses * rules.burnPercent / 100, platformUnits: losses * rules.platformPercent / 100, activityUnits: losses * rules.activityPercent / 100 },
    netUnits: rounds - returnUnits,
  };
}
