import { CONFIG, OBSTACLES } from './config.js';
import { DEFAULT_CATALOG } from './catalog.js';

// Distance determines the baseline. Releasing boost never resets late-game difficulty.
// speedCurve > 1 puts the acceleration late in the run (越跑越快)；< 1 则前段先快。
export function difficultyAt(distance, rules = CONFIG) {
  const progress = Math.max(0, Math.min(1, distance / rules.maxDistance));
  // 地狱模式换挡：speedStep > 0 时，巡航速度按固定米数量化成阶梯档位。
  // 每跨过一档，目标速度瞬间抬升（引擎约 0.25 秒内平滑跟上），体感像
  // 赛车连续换挡——campaign 用 10 米一档，全程 150 档，档档不同。
  const gate = rules.speedStep > 0 ? Math.floor(distance / rules.speedStep) * rules.speedStep : distance;
  const gateProgress = Math.max(0, Math.min(1, gate / rules.maxDistance));
  // 冲刺段（surgeAfter 米之后）：速度额外叠加、行距再压缩，越接近终点越接近反应极限。
  const surgeSpan = Math.max(1, rules.maxDistance - (rules.surgeAfter || 0));
  const surge = rules.surgeAfter > 0 && distance > rules.surgeAfter
    ? Math.min(1, (distance - rules.surgeAfter) / surgeSpan) : 0;
  return {
    cruise: rules.baseSpeed + (rules.maxSpeed - rules.baseSpeed) * gateProgress ** (rules.speedCurve || .85)
      + (rules.surgeSpeed || 0) * surge ** 1.15,
    rowSpacing: Math.max(8, rules.rowSpacingStart + (rules.rowSpacingEnd - rules.rowSpacingStart) * progress
      - (rules.surgeSpacing || 0) * surge),
    doubleChance: rules.doubleChanceStart + (rules.doubleChanceEnd - rules.doubleChanceStart) * progress,
    changeChance: rules.changeChanceStart + (rules.changeChanceEnd - rules.changeChanceStart) * progress,
  };
}
export function targetSpeed(distance, taps, rules = CONFIG) {
  const { cruise } = difficultyAt(distance, rules);
  const boost = taps >= rules.rocketTapRate ? rules.rocketSpeed - rules.maxSpeed : Math.min(8, Math.max(0, taps) * 1.4);
  // 冲刺段巡航速度会超过 rocketSpeed，封顶必须跟着抬，否则 Ultra 加速会被夹回去。
  return Math.min(Math.max(rules.rocketSpeed, cruise), cruise + boost);
}
export function obstacleRow(random, distance, previousSafe = 1, rules = CONFIG, catalog = DEFAULT_CATALOG) {
  const difficulty = difficultyAt(distance, rules);
  const adjacent = [0, 1, 2].filter(lane => Math.abs(lane - previousSafe) === 1);
  let safeLane = previousSafe;
  if (random() < difficulty.changeChance) safeLane = adjacent[Math.floor(random() * adjacent.length)];
  // Force frequent adjacent changes, while keeping a traversable route through every row.
  const alternatives = [0, 1, 2].filter(lane => lane !== safeLane);
  const double = random() < difficulty.doubleChance;
  const blocked = double ? alternatives : [safeLane !== previousSafe
    ? previousSafe : alternatives[Math.floor(random() * alternatives.length)]];
  const scene = Math.min(2, Math.floor(distance / (rules.maxDistance / 3)));
  const available = OBSTACLES.map(hazard => ({ ...hazard, ...catalog[hazard.id] }))
    .filter(hazard => hazard.enabled && hazard.weight > 0 && hazard.minDistance <= distance && hazard.scenes.includes(scene));
  return { safeLane, obstacles: blocked.flatMap(lane => {
    const choices = available.filter(hazard => hazard.lanes.includes(lane));
    if (!choices.length) return [];
    const total = choices.reduce((sum, hazard) => sum + hazard.weight, 0);
    const ticket = random() * total; let ceiling = 0;
    const selected = choices.find(hazard => (ceiling += hazard.weight) > ticket) || choices.at(-1);
    return [{ ...selected, lane, warningDistance: rules.warningDistance, ahead: rules.warningDistance, passed: false }];
  }) };
}
