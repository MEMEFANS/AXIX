import { formatUnits } from 'ethers';
import { readAixIncome, splitStakePayment } from './a-token-income.js';

const A_TOKEN_DECIMALS = 18;
const MINER_NAMES = { mini120: 'Mini 矿机', pro1500: 'Pro 矿机' };
const fmtA = units => { try { return formatUnits(BigInt(units || '0'), A_TOKEN_DECIMALS); } catch { return '0'; } };
const timeOf = value => {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
};
const beijingDay = value => {
  const ts = timeOf(value);
  return ts ? new Date(ts + 8 * 3600_000).toISOString().slice(0, 10) : '';
};
const todayBeijing = () => beijingDay(Date.now());

// 收益类型标签（仅 AIX 口径；USDT 类收益如跟单推荐/交易手续费推荐在「推荐」页展示）
const KIND_LABELS = {
  miner: '矿机产出',
  stake: '质押收益',
  miner_direct: '直推·矿机',
  miner_indirect: '间推·矿机',
  miner_team: '团队奖·矿机',
  miner_level_diff: '级差·矿机',
  miner_parity: '平级·矿机',
  stake_direct: '直推·质押',
  stake_indirect: '间推·质押',
  stake_team: '团队奖·质押',
  stake_level_diff: '级差·质押',
  stake_parity: '平级·质押',
  parity: '平级奖',
  a10_pool_share: 'A10 分红',
  direct_count: '直推阶梯奖',
};

// 汇总用户的 AIX 收益流水（全部为 A 币、18 位精度）
// 来源：矿机产出、质押收益、团队分润（直推/间推/级差/平级）、A10 分红、直推阶梯奖
// 注意：AI 跟单推荐（10%）与交易手续费推荐（50%）发的是 USDT（6 位精度），不属于 AIX 收益，
//       已在「推荐」页 /api/referrals/profile 按 USDT 展示，此处不再混入。
export function createATokenRevenueService({ database }) {
  const db = database;

  function listRevenue(wallet, { limit = 100, kind = '' } = {}) {
    const addr = String(wallet || '').toLowerCase();
    const rows = [];

    // 1. 矿机产出（按北京日聚合：日结一天一条，历史分钟数据同样按北京日合并）
    try {
      const miners = readAixIncome(db, addr, 'miner');
      const minerNameById = new Map();
      for (const m of db.listATokenMiners(addr)) {
        minerNameById.set(m.id, MINER_NAMES[m.plan] || m.plan || m.id);
      }
      const byDay = {};
      for (const r of miners) {
        // 北京日期：UTC+8 后取 ISO 日期（仅用于按天聚合，不展示）
        const day = new Date(Number(r.releasedAt) + 8 * 3600_000).toISOString().slice(0, 10);
        if (!byDay[day]) byDay[day] = { date: day, amountUnits: 0n, count: 0, minerIds: new Set(), minerNames: new Set(), latestAt:0 };
        byDay[day].amountUnits += BigInt(r.amountUnits || '0');
        byDay[day].count++;
        byDay[day].latestAt = Math.max(byDay[day].latestAt, Number(r.releasedAt));
        if (r.minerId) {
          byDay[day].minerIds.add(r.minerId);
          const nm = minerNameById.get(r.minerId);
          if (nm) byDay[day].minerNames.add(nm);
        }
      }
      for (const { date, amountUnits, count, minerIds, minerNames, latestAt } of Object.values(byDay)) {
        const names = [...minerNames];
        const subject = names.length ? names.join('、') : `${minerIds.size} 台矿机`;
        rows.push({
          id: `miner_day_${date}`, kind: 'miner', label: KIND_LABELS.miner,
          amount: fmtA(amountUnits.toString()), amountUnits: amountUnits.toString(),
          createdAt: latestAt, // 当日最后一笔实际入账时间
          detail: `${subject} · ${count} 笔到账`,
        });
      }
    } catch (error) { throw new Error(`AIX 收益读取失败：${error.message}`); }

    // 定期到账中的返还本金独立列示，不计入收益。
    let returnedPrincipalUnits = 0n;
    const stakesById = new Map(db.listATokenStakes(addr).map(stake => [stake.id, stake]));
    const paidByStake = new Map();
    for (const r of readAixIncome(db, addr, 'stake')) {
      const stake = stakesById.get(r.stakeId);
      const paid = paidByStake.get(r.stakeId) || 0n;
      const amount = BigInt(r.amountUnits || '0');
      let principal = r.principalUnits != null ? BigInt(r.principalUnits) : 0n;
      if (r.principalUnits == null && stake) {
        const original = {...stake, principalReturnedUnits:undefined, interestEarnedUnits:undefined};
        principal = splitStakePayment(original, paid + amount).principal - splitStakePayment(original, paid).principal;
      }
      paidByStake.set(r.stakeId, paid + amount);
      const interest = r.interestUnits != null ? BigInt(r.interestUnits) : amount - principal;
      returnedPrincipalUnits += principal;
      rows.push({ id:r.id, kind:'stake', label:'质押收益', amount:fmtA(interest), amountUnits:interest.toString(),
        createdAt:r.settledAt, principalReturned:fmtA(principal), creditedAmount:fmtA(amount),
        detail: `${stake?.planId === 'current' ? '活期' : '定期'}质押${principal > 0n ? ' · 另返还 AIX ' + Number(fmtA(principal)).toFixed(2) : ''}` });
    }

    // 3. 团队分润（矿机直推/间推/级差/平级 + A10 分红）
    try {
      const team = readAixIncome(db, addr, 'team');
      for (const r of team) {
        const k = r.kind || 'miner_direct';
        rows.push({
          id: r.id, kind: k, label: KIND_LABELS[k] || k,
          amount: fmtA(r.amountUnits), amountUnits: r.amountUnits,
          createdAt: r.createdAt,
          detail: r.sourceWallet ? `来自 ${r.sourceWallet.slice(0, 6)}…${r.sourceWallet.slice(-4)}` : '—',
          rate: r.rateBps != null ? `${Number(r.rateBps) / 100}%` : null,
        });
      }
    } catch (error) { throw new Error(`AIX 收益读取失败：${error.message}`); }

    // 4. 直推阶梯奖励
    try {
      const dc = readAixIncome(db, addr, 'direct');
      for (const r of dc) {
        rows.push({
          id: r.id, kind: 'direct_count', label: KIND_LABELS.direct_count,
          amount: fmtA(r.amountUnits), amountUnits: r.amountUnits,
          createdAt: r.createdAt,
          detail: `直推 ${r.directCount} 人 · ${Number(r.rateBps) / 100}%`,
        });
      }
    } catch (error) { throw new Error(`AIX 收益读取失败：${error.message}`); }

    // 按 kind 筛选
    let filtered = rows;
    if (kind) filtered = rows.filter(r => r.kind === kind);

    // 按时间倒序，取 limit
    filtered.sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
    const list = filtered.slice(0, Math.min(Number(limit) || 100, 500));

    // 汇总使用完整流水，避免 limit=200 时把历史累计收益截断。
    const allRows = rows.slice().sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
    const yesterday = new Date(Date.now() - 24 * 3600_000);
    const yesterdayDay = beijingDay(yesterday.getTime());
    const sumUnits = list => list.reduce((sum, r) => {
      try { return sum + BigInt(r.amountUnits || '0'); } catch { return sum; }
    }, 0n);
    const cumulativeUnits = sumUnits(allRows);
    const yesterdayUnits = sumUnits(allRows.filter(r => beijingDay(r.createdAt) === yesterdayDay));
    const minerUnits = sumUnits(allRows.filter(r => r.kind === 'miner'));
    const stakeUnits = sumUnits(allRows.filter(r => r.kind === 'stake'));
    const directUnits = sumUnits(allRows.filter(r => r.kind === 'direct_count' || r.kind === 'miner_direct' || r.kind === 'stake_direct'));
    const teamUnits = sumUnits(allRows.filter(r => !['miner','stake','direct_count','miner_direct','stake_direct'].includes(r.kind)));
    const teamTotalUnits = teamUnits + directUnits;

    // 按类型分组汇总
    const byKind = {};
    for (const r of allRows) {
      if (!byKind[r.kind]) byKind[r.kind] = { label: r.label, amountUnits: 0n, count: 0 };
      try { byKind[r.kind].amountUnits += BigInt(r.amountUnits || '0'); } catch {}
      byKind[r.kind].count++;
    }
    const summary = Object.entries(byKind).map(([k, v]) => ({
      kind: k, label: v.label, count: v.count, amount: fmtA(v.amountUnits.toString()),
    }));

    return {
      list,
      total: fmtA(cumulativeUnits.toString()),
      totalUnits: cumulativeUnits.toString(),
      stats: {
        cumulative: fmtA(cumulativeUnits.toString()),
        yesterday: fmtA(yesterdayUnits.toString()),
        miner: fmtA(minerUnits.toString()),
        stake: fmtA(stakeUnits.toString()),
        direct: fmtA(directUnits.toString()),
        team: fmtA(teamUnits.toString()),
        teamTotal: fmtA(teamTotalUnits),
        principalReturned:fmtA(returnedPrincipalUnits),
      },
      summary,
      count: list.length,
    };
  }

  return { listRevenue };
}
