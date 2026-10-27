// 纯操作闯关活动的内容表。
//
// Campaign 与 classic 试玩使用不同的规则和账本：这里没有门槛、收益档位或
// 开局结果抽取，关卡成绩只由玩家的跑动、闪避和收集表现决定。
import { DEFAULT_RULES, normalizeRules } from './rules.js';
import { DEFAULT_CATALOG, validateCatalog } from './catalog.js';

export const WORLDS = Object.freeze([
  Object.freeze({ id: 'world-1', index: 0, title: '星空之城', subtitle: '学会节奏，点亮第一颗星', color: '#a59bff', scene: 0 }),
  Object.freeze({ id: 'world-2', index: 1, title: '交易所大厅', subtitle: '在行情缝隙里保持连击', color: '#55f4dc', scene: 1 }),
  Object.freeze({ id: 'world-3', index: 2, title: '稳定币海域', subtitle: '穿过风暴，冲向极限', color: '#6feaff', scene: 2 }),
]);

// 单一连续关卡：1500 米星际航线一次跑完，没有关卡间隔，一击即死（地狱模式）。
// 40 → 130 m/s 逐档加速，场景随距离自动切换
// （art.js 按三分之一距离分段：星空之城 → 交易所大厅 → 稳定币海域）。
// normalizeRules 约束：1500 是允许的最远距离（保本线 300、翻倍线 600、步长 30）。
const LEVEL_SPECS = Object.freeze([
  { id: 'level-1', world: 0, title: '星际航线', subtitle: '1500 米连续航道，越跑越快', distance: 1500 },
]);

// A campaign world keeps one visual and obstacle language for its whole run.
// The shared generator still advances through three technical scene bands;
// all enabled campaign hazards therefore cover those bands, after theme filtering.
const WORLD_HAZARDS = Object.freeze([
  Object.freeze(['btc', 'eth', 'ghost', 'hole']),
  Object.freeze(['bnb', 'ltc', 'sol', 'doge', 'gas', 'bear', 'liquidation']),
  Object.freeze(['dai', 'usdt', 'xrp', 'whale', 'spike']),
]);

export function createCampaignCatalog(level, input = DEFAULT_CATALOG) {
  const spec = resolveSpec(level);
  if (!spec || !WORLD_HAZARDS[spec.world]) throw new RangeError('未知的闯关世界。');
  const source = validateCatalog(input);
  // 单一航线横跨三个星域：启用全部障碍类型，随航程逐段解锁。
  return validateCatalog(Object.fromEntries(Object.entries(source).map(([id, entry]) => [id, {
    ...entry,
    enabled: entry.enabled,
    scenes: [0, 1, 2],
    line: ['weather', 'slow'].includes(entry.behavior) ? '受到环境影响，保持节奏继续前进。' : '看清落点，提前换到旁边的车道。',
  }])));
}

function resolveSpec(level) {
  if (typeof level === 'string') return LEVEL_SPECS.find(item => item.id === level) || null;
  return level && typeof level === 'object' ? level : null;
}

/**
 * Build a normalized, non-economic rule set for a campaign level.
 * The distance milestones are proportional, so every level still has a
 * teachable opening, a mid-run checkpoint, and a clear finish line.
 */
export function createCampaignRules(level) {
  const spec = resolveSpec(level);
  if (!spec || !Number.isFinite(spec.distance) || spec.distance < 200) throw new RangeError('未知或无效的闯关关卡。');
  const maxDistance = Math.round(spec.distance);
  const breakevenDistance = maxDistance / 5;
  const checkpointDistance = maxDistance * 2 / 5;
  const stepDistance = maxDistance / 50;
  // 地狱换挡（2026-10-27）：40 → 130 m/s，每 10 米一档；1000 米保本线一过进入
  // 极限冲刺段——速度继续叠加到 430 m/s、行距再压到 16 米，几乎必然在此段阵亡。
  // 行距 55 → 26 米、双排 25% → 85%、强制换道 40% → 85%。
  // 预警距离 77 米：开局约 1.9 秒反应，冲刺段不足 0.2 秒。
  const baseSpeed = 40;
  const maxSpeed = 130;
  const rocketSpeed = 140;
  const surgeAfter = 1000;
  const surgeSpeed = 300;
  const surgeSpacing = 10;
  const rowSpacingStart = 55;
  const rowSpacingEnd = 26;
  const doubleChanceStart = .25;
  const doubleChanceEnd = .85;
  const changeChanceStart = .4;
  const changeChanceEnd = .85;
  const rules = {
    ...DEFAULT_RULES,
    mode: 'skill',
    minStake: 1, maxStake: 1, initialCredits: 100,
    maxDistance, breakevenDistance, checkpointDistance,
    stepDistance, stepMultiplier: .1, maxMultiplier: 5,
    lockFloorEnabled: false, floorMultiplier: 1,
    baseSpeed, maxSpeed, rocketSpeed, speedCurve: 1.5, speedStep: 10, rocketTapRate: 5,
    surgeAfter, surgeSpeed, surgeSpacing,
    // adventure UI 只有左右换道、没有连点通道（tap 只存在于 classic 页），
    // 强制连点会变成 0.65 秒必死断连。地狱压力全部来自速度/密度/视野。
    tapTimeout: .8, inputGrace: 1.2, continuousTapRequired: false,
    warningDistance: Math.max(30, Math.ceil(rocketSpeed * .55)),
    firstSpawnDistance: 2,
    rowSpacingStart, rowSpacingEnd,
    doubleChanceStart, doubleChanceEnd,
    changeChanceStart, changeChanceEnd,
    // Campaign runs never use the classic outcome template.
    lossWeight: 100, breakEvenWeight: 0, smallWinWeight: 0, doubleWeight: 0, highWinWeight: 0,
    newUserProtectionRounds: 0, roundCooldown: 0, dailyRoundLimit: 0,
  };
  return normalizeRules(rules);
}

const buildLevel = spec => Object.freeze({
  ...spec,
  worldId: WORLDS[spec.world]?.id,
  rules: createCampaignRules(spec),
});

export const LEVELS = Object.freeze(LEVEL_SPECS.map(buildLevel));

export function getLevel(id) {
  return LEVELS.find(level => level.id === id) || null;
}

