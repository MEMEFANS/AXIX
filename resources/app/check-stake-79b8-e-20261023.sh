#!/bin/bash
W=0x79b8cee7fb9724e3edb1c7e41bb353873df512e4
echo "=== pool meta keys ==="
sqlite3 /var/lib/wg-platform/wg-platform.sqlite "SELECT setting_key, substr(payload_json,1,600) FROM service_settings WHERE setting_key LIKE '%pool%' OR setting_key LIKE '%a_token%';"
echo
echo "=== node 直读质押展示数据 ==="
cd /opt/wg-platform
node --input-type=module -e "
import { openDatabase } from './src/database.js';
const db = openDatabase('/var/lib/wg-platform');
const W='$W';
const stakes = db.listATokenStakes(W);
const now = Date.now();
const DAY=86400000, BJ=28800000;
const bjDayStart = ts => Math.floor((ts+BJ)/DAY)*DAY-BJ;
const fmt = u => (Number(BigInt(u||'0'))/1e18).toFixed(4);
for (const s of stakes) {
  const plan = {current:{days:0,dailyRateBps:30,flex:true},s30:{days:30,dailyRateBps:80},s60:{days:60,dailyRateBps:100},s90:{days:90,dailyRateBps:120}}[s.planId];
  const principal = BigInt(s.principalUnits);
  const dailyInterest = principal*BigInt(plan.dailyRateBps)/10000n;
  const dailyDrip = plan.days? principal/BigInt(plan.days):0n;
  const lastAt = Number(s.lastSettledAt);
  const lastDayStart0 = bjDayStart(lastAt);
  const firstFull = lastAt===lastDayStart0? lastDayStart0 : lastDayStart0+DAY;
  const todayStart = bjDayStart(now);
  const daysReady = Math.max(0, Math.round((todayStart-firstFull)/DAY));
  console.log(JSON.stringify({
    id:s.id.slice(0,30), plan:s.planId, principal:fmt(s.principalUnits),
    dailyInterest:fmt(dailyInterest.toString()), dailyDrip:fmt(dailyDrip.toString()),
    totalEarned:fmt(s.totalEarnedUnits),
    startedAt:new Date(Number(s.startedAt)).toISOString(),
    lastSettled:new Date(lastAt).toISOString(),
    nextSettleAt:new Date(firstFull+DAY*(daysReady+1)).toISOString(),
    daysReadyToSettle:daysReady,
    status:s.status
  }));
}
db.close?.();
"
echo
echo "=== 质押任务定时器注册情况（server.js 里的 processAll 调度） ==="
grep -n "processAll\|stakingService" /opt/wg-platform/src/server.js | head -20
