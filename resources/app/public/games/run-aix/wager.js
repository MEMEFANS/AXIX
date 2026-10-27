// 奔跑吧 AIX 押注返还曲线（2026-10-27 定稿）：服务端结算与游戏内 HUD 共用这一份。
// 开跑即有 0.7 倍保底，1500 米通关 1.0 倍保本；里程碑前密后疏——
// 普通玩家（几百米）就能拿回约 0.9 倍，"少亏"；越往后每档越难、加成越小。
// 最高返还不超过本金：读屏脚本即使次次通关也只能保本，无法稳定刷钱。
export const WAGER = Object.freeze({
  maxDistance: 1500,
  basePercent: 70,
  maxPercent: 100,
  // [起始米数, 返还百分比]，必须单调递增
  milestones: Object.freeze([
    [0, 70], [100, 76], [200, 82], [300, 86], [500, 90], [800, 94], [1100, 97], [1500, 100],
  ].map(Object.freeze)),
});

const stepIndex = distance => {
  const d = Number.isFinite(distance) ? Math.max(0, distance) + 1e-8 : 0;
  let index = 0;
  WAGER.milestones.forEach(([meters], i) => { if (d >= meters) index = i; });
  return index;
};

// 返还百分比（整数，避免浮点）
export const wagerPercent = distance => WAGER.milestones[stepIndex(distance)][1];
export const wagerMultiplier = distance => wagerPercent(distance) / 100;

// 下一档：{ meters: 还差米数, gain: 加成百分点 }；已封顶返回 null
export function nextStep(distance) {
  const next = WAGER.milestones[stepIndex(distance) + 1];
  if (!next) return null;
  return { meters: Math.ceil(next[0] - Math.max(0, distance || 0)), gain: next[1] - wagerPercent(distance) };
}
