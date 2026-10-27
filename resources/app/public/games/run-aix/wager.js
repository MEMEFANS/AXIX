// 奔跑吧 AIX 押注返还曲线（2026-10-27 重建）：服务端结算与游戏内 HUD 共用这一份。
// 拒绝"只有通关才回本"：开跑即返 0.3 倍，跑到 300 米即保本 1.0 倍，
// 之后每 30 米 +0.1 倍，1500 米通关 5.0 倍——跑得越远，赚得越多。
// 里程碑前密后疏：0~300 米爬得快（早死也有返还），300 米后匀速加档。
export const WAGER = (() => {
  const milestones = [
    [0, 30], [50, 45], [100, 60], [150, 75], [200, 85], [250, 95], [300, 100],
  ];
  // 330 → 1500，每 30 米 +10%（即 +0.1 倍），1500 米封顶 5.0 倍
  for (let meters = 330; meters <= 1500; meters += 30) {
    milestones.push([meters, 100 + ((meters - 300) / 30) * 10]);
  }
  return Object.freeze({
    maxDistance: 1500,
    basePercent: 30,
    maxPercent: 500,
    breakevenDistance: 300,
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
