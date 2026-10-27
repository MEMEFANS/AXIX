import { formatUnits } from 'ethers';
import { randomUUID } from 'node:crypto';
import { A_TOKEN_DECIMALS } from './a-token-service.js';
import { splitStakePayment, readAixIncome } from './a-token-income.js';

// A 币质押任务包：日结（60s 定时巡检，北京时间每天 00:00 结算前一完整日，一天一条流水）。
// 活期 current: 100 起质押,日产 0.3%,随进随出（本金可随时赎回,利息日结）。
// 固定 s30/s60/s90: 月产 24%/30%/36%，本利同时产出（本金+利息按天滴灌,到期自动结清,不可提前赎回）。
// daily_rate_bps = 日收益率(bps of principal)。固定包每日产出 = 本金/days + 本金*rate/10000。
const DAY_MS = 24 * 60 * 60_000;
const BPS = 10_000n;
const A_UNIT = 10n ** BigInt(A_TOKEN_DECIMALS);
const BJ_OFFSET_MS = 8 * 60 * 60_000; // 北京时间 = UTC+8，每天 00:00（北京）日结
// 北京日界：ts 所在北京日的 00:00（UTC epoch 毫秒）
const bjDayStart = (ts) => Math.floor((Number(ts) + BJ_OFFSET_MS) / DAY_MS) * DAY_MS - BJ_OFFSET_MS;
// 北京日槽：自 epoch 起的北京日序号
const bjDaySlot = (ts) => Math.floor((Number(ts) + BJ_OFFSET_MS) / DAY_MS);

export const STAKE_PLANS = Object.freeze({
  // 活期已下线（2026-10-25）：存量已退本金结清，仅保留配置供历史记录展示
  current: { planId:'current', label:'活期', days:0, dailyRateBps:30, minUnits:(100n * A_UNIT).toString(), flexible:true },
  // 2026-10-25 起三档统一 1000 A 起步
  s30: { planId:'s30', label:'1号 30天', days:30, dailyRateBps:80, minUnits:(1000n * A_UNIT).toString(), flexible:false },
  s60: { planId:'s60', label:'2号 60天', days:60, dailyRateBps:100, minUnits:(1000n * A_UNIT).toString(), flexible:false },
  s90: { planId:'s90', label:'3号 90天', days:90, dailyRateBps:120, minUnits:(1000n * A_UNIT).toString(), flexible:false },
});

export function createATokenStakingService({ aTokenService, database, teamService, clock = () => Date.now() }) {
  const db = database;
  const insertRewardStmt = db.db.prepare(`INSERT INTO a_token_stake_rewards
    (id,stake_id,wallet,amount_units,settled_at,payload_json) VALUES(?,?,?,?,?,?)
    ON CONFLICT(id) DO NOTHING`);

  function planOf(planId) {
    const plan = STAKE_PLANS[planId];
    if (!plan) throw new Error('质押套餐无效');
    return plan;
  }
  // 每日产出（绝对 units）
  function dailyRewardOf(stake, plan) {
    const principal = BigInt(stake.principalUnits);
    const yieldPerDay = principal * BigInt(plan.dailyRateBps) / BPS;
    if (plan.flexible) return yieldPerDay; // 活期只产出利息,本金可赎回
    const principalDrip = principal / BigInt(plan.days); // 本金按天滴灌
    return principalDrip + yieldPerDay;
  }
  // 固定包最大可产出总量（本金 + 总利息）
  function maxTotalOf(stake, plan) {
    if (plan.flexible) return null; // 活期无上限
    const principal = BigInt(stake.principalUnits);
    return principal + principal * BigInt(plan.dailyRateBps) * BigInt(plan.days) / BPS;
  }

  function stake(wallet, planId, principalInput) {
    // 活期质押已于 2026-10-25 下线：存量本金已由后台统一退回，禁止新增
    if (planId === 'current') throw new Error('活期质押已下线，请选择固定期限质押');
    const plan = planOf(planId);
    const principal = aTokenService.parseA(principalInput, '质押数量');
    if (principal < BigInt(plan.minUnits)) throw new Error(`${plan.label} 最小质押 ${formatUnits(BigInt(plan.minUnits), A_TOKEN_DECIMALS)} A`);
    if (aTokenService.balanceA(wallet) < principal) throw new Error('A 币余额不足');
    const now = clock();
    aTokenService.debitA(wallet, principal);
    const stakeRow = {
      id: `ats_${planId}_${now}_${randomUUID()}`,
      wallet, planId: plan.planId, principalUnits: principal.toString(),
      dailyRateBps: plan.dailyRateBps, startedAt: now,
      expiresAt: plan.flexible ? 0 : now + plan.days * DAY_MS,
      lastSettledAt: now, dayEarnedUnits: '0', totalEarnedUnits: '0', status: 'active',
    };
    db.upsertATokenStakeRow(stakeRow);
    return stakeRow;
  }

  function paySettlement(stake, principal, interest, rewardId, settledAt, detail = {}) {
    if (db.db.prepare('SELECT 1 FROM a_token_stake_rewards WHERE id=?').get(rewardId)) return 0n;
    const earned = BigInt(stake.totalEarnedUnits);
    const before = splitStakePayment(stake, earned);
    // Returning the user's deposited principal does not mint new AIX or consume the reward quota.
    const grantedInterest = BigInt(aTokenService.creditStakingA(stake.wallet, interest) || '0');
    if (principal > 0n) aTokenService.creditA(stake.wallet, principal);
    const granted = principal + grantedInterest;
    if (granted <= 0n) return 0n;
    // 2026-10-25：质押释放的产出（本金滴灌 + 利息）计入可卖额度——平台上只有这部分 AIX 能挂卖
    try { db.addATokenSellQuota?.(stake.wallet, granted); }
    catch (e) { console.warn(`[质押额度] ${stake.wallet} 额度累加失败:`, e?.message || e); }
    const record = { id:rewardId, stakeId:stake.id, wallet:stake.wallet, amountUnits:granted.toString(),
      principalUnits:principal.toString(), interestUnits:grantedInterest.toString(), settledAt, ...detail };
    insertRewardStmt.run(rewardId, stake.id, stake.wallet, granted.toString(), settledAt, JSON.stringify(record));
    stake.totalEarnedUnits = (earned + granted).toString();
    stake.principalReturnedUnits = (before.principal + principal).toString();
    stake.interestEarnedUnits = (before.interest + grantedInterest).toString();
    stake.dayEarnedUnits = granted.toString();
    stake.lastSettledAt = detail.periodEndAt ?? settledAt;
    db.upsertATokenStakeRow(stake);
    teamService?.distributeStakeReward(stake.wallet, grantedInterest, stake.id, detail.periodEndAt ?? settledAt, settledAt);
    return granted;
  }

  function finalizeFixed(stake, now) {
    const plan = planOf(stake.planId);
    const maxTotal = maxTotalOf(stake, plan);
    const payment = splitStakePayment(stake, stake.totalEarnedUnits);
    const principal = BigInt(stake.principalUnits) - payment.principal;
    const interest = maxTotal - BigInt(stake.principalUnits) - payment.interest;
    if (principal + interest > 0n) paySettlement(stake, principal, interest,
      `asr_${stake.id}_final_${stake.totalEarnedUnits}`, now, {reason:'final'});
    if (BigInt(stake.totalEarnedUnits) >= maxTotal) stake.status = 'completed';
    db.upsertATokenStakeRow(stake);
  }

  function settleOne(stake, now) {
    if (stake.status !== 'active') return;
    const plan = planOf(stake.planId);
    if (!plan.flexible && now >= Number(stake.expiresAt)) { finalizeFixed(stake, now); return; }
    // 北京日结：只结算已完整度过的北京日（与矿机同口径），不足一天的零头固定包到期补齐
    const lastAt = Number(stake.lastSettledAt);
    if (now <= lastAt) return;
    const lastDayStart0 = bjDayStart(lastAt);
    const firstFullDayStart = lastAt === lastDayStart0 ? lastDayStart0 : lastDayStart0 + DAY_MS;
    const todayStart = bjDayStart(now);
    if (todayStart <= lastAt) return; // 今天（北京）尚未跨过 00:00，无完整日可结
    const days = Math.max(0, Math.round((todayStart - firstFullDayStart) / DAY_MS));
    if (days <= 0) return;
    const reward = dailyRewardOf(stake, plan);
    if (reward <= 0n) return;
    const maxTotal = maxTotalOf(stake, plan);
    let settledAny = false;
    // 每个完整北京日一条流水（服务中断恢复后逐天补齐），日界时刻结算
    for (let i = 1; i <= days; i += 1) {
      const dayBoundary = firstFullDayStart + i * DAY_MS; // 该完整日结束的北京日界（结算时刻）
      const d = bjDaySlot(dayBoundary);
      const payment = splitStakePayment(stake, stake.totalEarnedUnits);
      const dailyPrincipal = plan.flexible ? 0n : BigInt(stake.principalUnits) / BigInt(plan.days);
      const remainingPrincipal = BigInt(stake.principalUnits) - payment.principal;
      const principal = dailyPrincipal < remainingPrincipal ? dailyPrincipal : remainingPrincipal;
      let interest = BigInt(stake.principalUnits) * BigInt(plan.dailyRateBps) / BPS;
      if (maxTotal) {
        const remainingInterest = maxTotal - BigInt(stake.principalUnits) - payment.interest;
        if (interest > remainingInterest) interest = remainingInterest;
      }
      const rewardId = `asr_${stake.id}_${d}`;
      const granted = paySettlement(stake, principal, interest, rewardId, now, {day:d, periodEndAt:dayBoundary});
      if (granted <= 0n) continue;
      settledAny = true;
      if (maxTotal && BigInt(stake.totalEarnedUnits) >= maxTotal) break;
    }
    if (maxTotal && BigInt(stake.totalEarnedUnits) >= maxTotal) { finalizeFixed(stake, now); return; }
    if (settledAny) db.upsertATokenStakeRow(stake);
  }

  function processAll(now = clock()) {
    const stakes = db.listActiveATokenStakes();
    for (const s of stakes) aTokenService.transaction(() => settleOne(s, now));
    return stakes.length;
  }

  // 活期赎回：返还本金（利息已日结）
  function unstake(wallet, stakeId) {
    const stakes = db.listATokenStakes(wallet);
    const target = stakes.find(s => s.id === stakeId);
    if (!target) throw new Error('未找到该质押记录');
    if (target.status !== 'active') throw new Error('该质押已结束');
    const plan = planOf(target.planId);
    if (!plan.flexible) throw new Error('固定任务包不可提前赎回,请到期后自动结清');
    settleOne(target, clock()); // 先结算当日
    if (target.status !== 'active') return target; // 已结清
    const principal = BigInt(target.principalUnits);
    aTokenService.creditA(wallet, principal);
    target.status = 'completed';
    target.lastSettledAt = clock();
    db.upsertATokenStakeRow(target);
    return target;
  }

  // 活期质押下线退款（2026-10-25）：所有 active 活期质押一次性退本金、标记结清、停止产出。
  // 不结当日利息（利息此前已日结发完），与 unstake 的区别是不调 settleOne。
  function refundAllFlexible(now = clock()) {
    const all = db.listActiveATokenStakes().filter(s => s.planId === 'current');
    let refunded = 0;
    let totalUnits = 0n;
    for (const s of all) {
      aTokenService.transaction(() => {
        const principal = BigInt(s.principalUnits);
        if (principal > 0n) aTokenService.creditA(s.wallet, principal);
        s.status = 'completed';
        s.lastSettledAt = now;
        db.upsertATokenStakeRow(s);
      });
      refunded += 1;
      totalUnits += BigInt(s.principalUnits);
    }
    return { refunded, totalUnits: totalUnits.toString(), totalA: formatUnits(totalUnits, A_TOKEN_DECIMALS) };
  }

  // 全部质押一次性退回（2026-10-25）：所有在架质押（含 30/60/90 天固定档）退还剩余未返还本金、
  // 标记结清、停止产出。已日结发放的利息不追回；未结算的零头利息不再发放。
  // 退回的本金不计入可卖额度（可卖额度只来自质押每日释放的产出）。
  function refundAllStakes(now = clock()) {
    const all = db.listActiveATokenStakes();
    let refunded = 0;
    let totalUnits = 0n;
    for (const s of all) {
      let remaining = 0n;
      aTokenService.transaction(() => {
        const payment = splitStakePayment(s, s.totalEarnedUnits);
        remaining = BigInt(s.principalUnits) - payment.principal;
        if (remaining < 0n) remaining = 0n;
        if (remaining > 0n) aTokenService.creditA(s.wallet, remaining);
        s.status = 'completed';
        s.lastSettledAt = now;
        db.upsertATokenStakeRow(s);
      });
      refunded += 1;
      totalUnits += remaining;
    }
    return { refunded, totalUnits: totalUnits.toString(), totalA: formatUnits(totalUnits, A_TOKEN_DECIMALS) };
  }

  function present(wallet) {
    const stakes = db.listATokenStakes(wallet);
    const now = clock();
    const today = new Map();
    for (const row of readAixIncome(db, wallet, 'stake')) {
      if (bjDayStart(row.settledAt) === bjDayStart(now)) today.set(row.stakeId, (today.get(row.stakeId) || 0n) + BigInt(row.amountUnits));
    }
    return stakes.map(s => {
      const plan = planOf(s.planId);
      const maxTotal = maxTotalOf(s, plan);
      const earned = BigInt(s.totalEarnedUnits);
      const payment = splitStakePayment(s, earned);
      // 实时预估（未结算累计）
      const liveAccrued = s.status === 'active' ? dailyRewardOf(s, plan) * BigInt(Math.max(0, now - Number(s.lastSettledAt))) / BigInt(DAY_MS) : 0n;
      const liveEarned = maxTotal ? (earned + liveAccrued > maxTotal ? maxTotal : earned + liveAccrued) : earned + liveAccrued;
      return {
        ...s,
        label: plan.label,
        flexible: plan.flexible,
        days: plan.days,
        dailyRateBps: plan.dailyRateBps,
        principal: formatUnits(BigInt(s.principalUnits), A_TOKEN_DECIMALS),
        dayEarned: formatUnits(today.get(s.id) || 0n, A_TOKEN_DECIMALS),
        totalEarned: formatUnits(earned, A_TOKEN_DECIMALS),
        interestEarned: formatUnits(payment.interest, A_TOKEN_DECIMALS),
        principalReturned: formatUnits(plan.flexible && s.status !== 'active' ? BigInt(s.principalUnits) : payment.principal, A_TOKEN_DECIMALS),
        outstandingPrincipal: formatUnits(payment.outstanding, A_TOKEN_DECIMALS),
        estimatedPending: formatUnits(liveEarned - earned, A_TOKEN_DECIMALS),
        maxTotal: maxTotal ? formatUnits(maxTotal, A_TOKEN_DECIMALS) : null,
        progressPct: maxTotal ? Number(earned * 10_000n / maxTotal) / 100 : null,
        startedAt: Number(s.startedAt),
        expiresAt: Number(s.expiresAt),
      };
    });
  }

  return { stake:(...args) => aTokenService.transaction(() => stake(...args)), unstake:(...args) => aTokenService.transaction(() => unstake(...args)), processAll, refundAllFlexible, refundAllStakes, present, STAKE_PLANS, planOf };
}
