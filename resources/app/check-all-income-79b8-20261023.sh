#!/bin/bash
DB=/var/lib/wg-platform/wg-platform.sqlite
W=0x79b8cee7fb9724e3edb1c7e41bb353873df512e4
DAY=86400000; BJ=28800000
bjDayStart() { echo $(( ($1 + $BJ) / $DAY * $DAY - $BJ )); }

echo "========== 一、矿机收益 =========="
sqlite3 -header "$DB" "SELECT id, plan, printf('%.4f',CAST(total_units AS REAL)/1e18) AS total_A, printf('%.4f',CAST(daily_target_units AS REAL)/1e18) AS daily_target_A, datetime(started_at/1000,'unixepoch','+8 hours') AS started_bj, datetime(expires_at/1000,'unixepoch','+8 hours') AS expires_bj, datetime(last_release_at/1000,'unixepoch','+8 hours') AS last_release_bj, printf('%.4f',CAST(total_earned_units AS REAL)/1e18) AS earned_A, status FROM a_token_miners WHERE lower(wallet)='$W';"
echo
echo "--- 矿机每日释放明细 ---"
sqlite3 -header "$DB" "SELECT datetime(released_at/1000,'unixepoch','+8 hours') AS released_bj, printf('%.4f',CAST(amount_units AS REAL)/1e18) AS amt_A FROM a_token_miner_releases WHERE lower(wallet)='$W' ORDER BY released_at;"
echo
echo "--- 校验：1500 A / 90 天 = 16.6667 A/天，释放次数与累计 ---"
sqlite3 "$DB" "SELECT printf('释放次数=%d  累计=%.4f A  理论日额=%.4f A  1500/90=%.4f A', COUNT(*), SUM(CAST(amount_units AS REAL)/1e18), AVG(CAST(amount_units AS REAL)/1e18), 1500.0/90) FROM a_token_miner_releases WHERE lower(wallet)='$W';"

echo
echo "========== 二、质押收益 =========="
sqlite3 -header "$DB" "SELECT plan_id, printf('%.2f',CAST(principal_units AS REAL)/1e18) AS principal_A, daily_rate_bps AS bps, datetime(started_at/1000,'unixepoch','+8 hours') AS started_bj, datetime(expires_at/1000,'unixepoch','+8 hours') AS expires_bj, printf('%.4f',CAST(total_earned_units AS REAL)/1e18) AS earned_A, json_extract(payload_json,'$.interestEarnedUnits') AS interest_units, status FROM a_token_stakes WHERE lower(wallet)='$W';"
echo
echo "--- 质押每日结算明细（本金滴灌+利息）---"
sqlite3 -header "$DB" "SELECT r.stake_id, datetime(r.settled_at/1000,'unixepoch','+8 hours') AS settled_bj, printf('%.4f',CAST(r.amount_units AS REAL)/1e18) AS total_A, printf('%.4f',CAST(json_extract(r.payload_json,'$.interestUnits') AS REAL)/1e18) AS interest_A, printf('%.4f',CAST(json_extract(r.payload_json,'$.principalUnits') AS REAL)/1e18) AS principal_A FROM a_token_stake_rewards r WHERE lower(r.wallet)='$W' ORDER BY r.settled_at;"
echo
echo "--- 质押利息校验：利息=本金×dailyRateBps/1e4/天 ---"
sqlite3 "$DB" "SELECT stake_id, printf('利息笔数=%d  累计利息=%.4f A', COUNT(*), SUM(CAST(json_extract(payload_json,'$.interestUnits') AS REAL)/1e18)) FROM a_token_stake_rewards WHERE lower(wallet)='$W' GROUP BY stake_id;"

echo
echo "========== 三、团队分润收益 =========="
sqlite3 -header "$DB" "SELECT kind, COUNT(*) AS cnt, printf('%.4f',SUM(CAST(amount_units AS REAL)/1e18)) AS total_A, datetime(MIN(created_at)/1000,'unixepoch','+8 hours') AS first_bj, datetime(MAX(created_at)/1000,'unixepoch','+8 hours') AS last_bj FROM a_token_team_rewards WHERE lower(recipient_wallet)='$W' GROUP BY kind ORDER BY total_A DESC;"

echo
echo "========== 四、直推阶梯奖 =========="
sqlite3 -header "$DB" "SELECT COUNT(*) AS cnt, printf('%.4f',SUM(CAST(amount_units AS REAL)/1e18)) AS total_A, datetime(MAX(created_at)/1000,'unixepoch','+8 hours') AS last_bj FROM a_token_direct_count_rewards WHERE lower(recipient_wallet)='$W';" 2>/dev/null || echo "(无此表或无记录)"

echo
echo "========== 五、收益页汇总（服务端 revenue service 口径：利息口径）=========="
echo "(调用 /api/a-token/revenue 需要 session，此处用 node 直读模拟)"
cd /opt/wg-platform
node --input-type=module -e "
import { openDatabase } from './src/database.js';
import { createATokenRevenueService } from './src/a-token-revenue-service.js';
const db = openDatabase('/var/lib/wg-platform');
const svc = createATokenRevenueService({ database: db });
const r = svc.listRevenue('$W', { limit: 500 });
console.log('累计收益(利息口径):', r.total, 'AIX');
console.log('昨日收益:', r.stats.yesterday, 'AIX');
console.log('矿机收益:', r.stats.miner, '  质押收益:', r.stats.stake, '  直推:', r.stats.direct, '  团队:', r.stats.team, '  团队+直推:', r.stats.teamTotal);
console.log('已返还本金:', r.stats.principalReturned, 'AIX');
console.log('按类型分组:');
for (const s of r.summary) console.log(' ', s.kind, s.label, 'x'+s.count, '=', s.amount, 'AIX');
db.close?.();
" 2>/dev/null | grep -v ExperimentalWarning | grep -v trace-warnings

echo
echo "========== 六、钱包 A 余额 =========="
sqlite3 -header "$DB" "SELECT printf('%.4f',CAST(json_extract(payload_json,'\$.balances.A') AS REAL)/1e18) AS balance_A FROM wallet_users WHERE lower(address)='$W';"
