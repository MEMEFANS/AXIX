import { openDatabase } from './src/database.js';
import { formatUnits } from 'ethers';

const db = openDatabase('/var/lib/wg-platform');

// 矿机总览统计（active 状态）
const stats = db.minerStats();
console.log('=== 矿机总览（active 状态）===');
console.log('activeCount=' + stats.activeCount);

// 逐台看 mini 的日产出
const miniSample = db.listActiveATokenMiners ? db.listActiveATokenMiners(1).filter(m => m.plan === 'mini120')[0] : null;
if (miniSample) {
  console.log('mini_daily_target_units=' + miniSample.dailyTargetUnits);
  console.log('mini_daily_target_aix=' + formatUnits(BigInt(miniSample.dailyTargetUnits || '0'), 18));
  console.log('mini_total_units=' + miniSample.totalUnits);
  console.log('mini_total_aix=' + formatUnits(BigInt(miniSample.totalUnits || '0'), 18));
  console.log('mini_duration_days=' + miniSample.durationDays);
}

const proSample = db.listActiveATokenMiners ? db.listActiveATokenMiners(1).filter(m => m.plan === 'pro1500')[0] : null;
if (proSample) {
  console.log('pro_daily_target_units=' + proSample.dailyTargetUnits);
  console.log('pro_daily_target_aix=' + formatUnits(BigInt(proSample.dailyTargetUnits || '0'), 18));
  console.log('pro_total_units=' + proSample.totalUnits);
  console.log('pro_total_aix=' + formatUnits(BigInt(proSample.totalUnits || '0'), 18));
  console.log('pro_duration_days=' + proSample.durationDays);
}

// 每日总产出
const miniDaily = BigInt(stats.byPlan.mini120?.dailyTargetUnits || '0');
const proDaily = BigInt(stats.byPlan.pro1500?.dailyTargetUnits || '0');
const totalDaily = miniDaily + proDaily;
console.log('=== 每日总产出 ===');
console.log('mini_daily_aix=' + formatUnits(miniDaily, 18));
console.log('pro_daily_aix=' + formatUnits(proDaily, 18));
console.log('total_daily_aix=' + formatUnits(totalDaily, 18));
