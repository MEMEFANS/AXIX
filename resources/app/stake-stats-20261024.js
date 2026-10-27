import { openDatabase } from './src/database.js';
import { formatUnits } from 'ethers';

const db = openDatabase('/var/lib/wg-platform');

const stakes = db.listActiveATokenStakes();
console.log('active_stakes=' + stakes.length);

// 按日利率分组
const byRate = {};
for (const s of stakes) {
  const rate = s.dailyRateBps || 0;
  if (!byRate[rate]) byRate[rate] = { count: 0, principal: 0n, earned: 0n };
  byRate[rate].count += 1;
  byRate[rate].principal += BigInt(s.principalUnits || '0');
  byRate[rate].earned += BigInt(s.totalEarnedUnits || '0');
}

console.log('=== 按日利率分组 ===');
let totalPrincipal = 0n;
let totalDaily = 0n;
for (const [rateBps, d] of Object.entries(byRate)) {
  const rate = Number(rateBps) / 10000;
  const daily = d.principal * BigInt(rateBps) / 10000n;
  totalPrincipal += d.principal;
  totalDaily += daily;
  console.log('rate=' + rateBps + 'bps(' + (rate*100).toFixed(2) + '%/天): count=' + d.count + ', principal=' + formatUnits(d.principal, 18) + ' AIX, daily=' + formatUnits(daily, 18) + ' AIX, earned=' + formatUnits(d.earned, 18) + ' AIX');
}
console.log('=== 汇总 ===');
console.log('total_principal=' + formatUnits(totalPrincipal, 18) + ' AIX');
console.log('total_daily=' + formatUnits(totalDaily, 18) + ' AIX');
