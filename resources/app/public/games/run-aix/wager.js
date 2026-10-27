// 奔跑吧 AIX 押注返还曲线（2026-10-27 重建）：服务端结算与游戏内 HUD 共用这一份。
// 保本线设在 1000 米：开跑即返 0.3 倍，越跑越接近保本，1000 米回到 1.0 倍；
// 1000 米之后难度与收益一起陡增，1200 米 2 倍、1500 米通关 5 倍。
export const WAGER = (() => {
  const milestones = [
    [0, 30], [100, 40], [200, 50], [300, 55], [400, 60], [500, 68],
    [600, 75], [700, 82], [800, 88], [900, 94], [1000, 100],
    [1100, 140], [1200, 200], [1300, 280], [1400, 380], [1500, 500],
  ];
  return Object.freeze({
    maxDistance: 1500,
    basePercent: 30,
    maxPercent: 500,
    breakevenDistance: 1000,
    milestones: Object.freeze(milestones.map(Object.freeze)),
  });
})();

const stepIndex = distance => {
  const d = Number.isFinite(distance) ? Math.max(0, distance) + 1e-8 : 0;
  let index = 0;
  WAGER.milestones.forEach(([meters], i) => { if (d >= meters) index = i; });
  return index;
};

// 返还百分比（整数，避免浮点）：100 = 保本，500 = 5 倍
export const wagerPercent = distance => WAGER.milestones[stepIndex(distance)][1];
export const wagerMultiplier = distance => wagerPercent(distance) / 100;

// 下一档：{ meters: 还差米数, gain: 加成百分点 }；已封顶返回 null
export function nextStep(distance) {
  const next = WAGER.milestones[stepIndex(distance) + 1];
  if (!next) return null;
  return { meters: Math.ceil(next[0] - Math.max(0, distance || 0)), gain: next[1] - wagerPercent(distance) };
}
