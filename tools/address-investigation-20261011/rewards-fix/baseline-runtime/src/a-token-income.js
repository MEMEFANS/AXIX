import { formatUnits } from 'ethers';

export const AIX_DAY_MS = 86400000;
export const beijingDayStart = time => Math.floor((Number(time) + 28800000) / AIX_DAY_MS) * AIX_DAY_MS - 28800000;
export const formatAix = value => formatUnits(BigInt(value || '0'), 18);
const parse = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };

// Old releases stored amount/time in SQL columns but omitted them from payload_json.
// Read the authoritative columns and all rows when calculating cumulative income.
export function readAixIncome(database, wallet, kind) {
  const sources = {
    miner: ['a_token_miner_releases', 'wallet', 'released_at'],
    stake: ['a_token_stake_rewards', 'wallet', 'settled_at'],
    team: ['a_token_team_rewards', 'recipient_wallet', 'created_at'],
    direct: ['a_token_direct_count_rewards', 'recipient_wallet', 'created_at'],
  };
  const source = sources[kind];
  if (!source) throw new Error('无效的 AIX 收益类型');
  const [table, owner, time] = source;
  return database.db.prepare(`SELECT * FROM ${table} WHERE ${owner} = ? COLLATE NOCASE ORDER BY ${time}, id`).all(wallet).map(row => ({
    ...parse(row.payload_json), id:row.id, wallet:row.wallet || row.recipient_wallet,
    recipientWallet:row.recipient_wallet, sourceWallet:row.source_wallet,
    minerId:row.miner_id, stakeId:row.stake_id,
    amountUnits:row.amount_units, createdAt:row[time], releasedAt:row.released_at, settledAt:row.settled_at,
    kind:row.kind || (kind === 'direct' ? 'direct_count' : kind), rateBps:row.rate_bps,
    directCount:row.direct_count,
  }));
}

// Existing fixed packages drip principal and interest together. Separate that
// payment for reporting without changing credited amounts or historic records.
export function splitStakePayment(stake, paidUnits) {
  const paid = BigInt(paidUnits || '0');
  const principal = BigInt(stake.principalUnits || '0');
  const days = { s30:30, s60:60, s90:90 }[stake.planId] || 0;
  if (stake.principalReturnedUnits != null && stake.interestEarnedUnits != null && paid === BigInt(stake.totalEarnedUnits || '0')) {
    const returned = BigInt(stake.principalReturnedUnits);
    return { principal:returned, interest:BigInt(stake.interestEarnedUnits), outstanding:stake.status === 'active' ? principal - returned : 0n };
  }
  if (!days) return { principal:0n, interest:paid, outstanding:stake.status === 'active' ? principal : 0n };
  const dailyPrincipal = principal / BigInt(days);
  const dailyInterest = principal * BigInt(stake.dailyRateBps || '0') / 10000n;
  const daily = dailyPrincipal + dailyInterest;
  const maxTotal = principal + principal * BigInt(stake.dailyRateBps || '0') * BigInt(days) / 10000n;
  let returned = paid >= maxTotal ? principal : daily > 0n ? (paid / daily) * dailyPrincipal + (paid % daily) * dailyPrincipal / daily : 0n;
  if (returned > principal) returned = principal;
  return { principal:returned, interest:paid - returned, outstanding:stake.status === 'active' ? principal - returned : 0n };
}

export function minerIncomeSummary(database, wallet, now) {
  const day = beijingDayStart(now), summaries = new Map();
  for (const row of readAixIncome(database, wallet, 'miner')) {
    const summary = summaries.get(row.minerId) || { total:0n, today:0n, yesterday:0n };
    const amount = BigInt(row.amountUnits || '0');
    summary.total += amount;
    if (row.createdAt >= day && row.createdAt < day + AIX_DAY_MS) summary.today += amount;
    if (row.createdAt >= day - AIX_DAY_MS && row.createdAt < day) summary.yesterday += amount;
    summaries.set(row.minerId, summary);
  }
  return summaries;
}
