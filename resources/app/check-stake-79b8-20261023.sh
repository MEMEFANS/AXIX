#!/bin/bash
DB=/var/lib/wg-platform/wg-platform.sqlite
W=0x79b8cee7fb9724e3edb1c7e41bb353873df512e4
echo "=== stakes ==="
sqlite3 -header "$DB" "SELECT id, plan_id, principal_units, daily_rate_bps, started_at, expires_at, last_settled_at, total_earned_units, principal_returned_units, interest_earned_units, status FROM a_token_stakes WHERE lower(wallet)='$W' ORDER BY started_at;"
echo
echo "=== rewards (latest 30) ==="
sqlite3 -header "$DB" "SELECT id, stake_id, amount_units, settled_at, json_extract(payload_json,'$.day') AS day, json_extract(payload_json,'$.reason') AS reason, json_extract(payload_json,'$.interestUnits') AS interest, json_extract(payload_json,'$.principalUnits') AS principal FROM a_token_stake_rewards WHERE lower(wallet)='$W' ORDER BY settled_at DESC LIMIT 30;"
echo
echo "=== rewards count/sum ==="
sqlite3 -header "$DB" "SELECT stake_id, COUNT(*) AS cnt, SUM(CAST(amount_units AS INTEGER)) AS total_units, MIN(settled_at) AS first_at, MAX(settled_at) AS last_at FROM a_token_stake_rewards WHERE lower(wallet)='$W' GROUP BY stake_id;"
echo
echo "=== now / 北京今日日界 ==="
date -u +%s%3N
TZ=Asia/Shanghai date
echo
echo "=== 最近服务重启/质押结算日志 ==="
grep -a "质押" /opt/wg-platform/logs/server.stdout.log | tail -5 || true
echo "--- stderr tail ---"
tail -20 /opt/wg-platform/logs/server.stderr.log
