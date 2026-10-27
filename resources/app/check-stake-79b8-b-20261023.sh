#!/bin/bash
DB=/var/lib/wg-platform/wg-platform.sqlite
W=0x79b8cee7fb9724e3edb1c7e41bb353873df512e4
echo "=== stakes (payload parsed) ==="
sqlite3 -header "$DB" "SELECT id, plan_id, principal_units, daily_rate_bps, datetime(started_at/1000,'unixepoch','+8 hours') AS started_bj, datetime(expires_at/1000,'unixepoch','+8 hours') AS expires_bj, datetime(last_settled_at/1000,'unixepoch','+8 hours') AS last_settled_bj, total_earned_units, json_extract(payload_json,'$.principalReturnedUnits') AS principal_returned, json_extract(payload_json,'$.interestEarnedUnits') AS interest_earned, status FROM a_token_stakes WHERE lower(wallet)='$W' ORDER BY started_at;"
echo
echo "=== rewards per stake (SUM as real to avoid overflow) ==="
sqlite3 -header "$DB" "SELECT stake_id, COUNT(*) AS cnt, printf('%.4f', SUM(CAST(amount_units AS REAL)/1e18)) AS total_A, datetime(MIN(settled_at)/1000,'unixepoch','+8 hours') AS first_bj, datetime(MAX(settled_at)/1000,'unixepoch','+8 hours') AS last_bj FROM a_token_stake_rewards WHERE lower(wallet)='$W' GROUP BY stake_id;"
echo
echo "=== 今日(北京)是否已有结算 ==="
sqlite3 -header "$DB" "SELECT id, printf('%.4f', CAST(amount_units AS REAL)/1e18) AS amount_A, datetime(settled_at/1000,'unixepoch','+8 hours') AS settled_bj FROM a_token_stake_rewards WHERE lower(wallet)='$W' AND settled_at >= (strftime('%s','now','utc','start of day')+28800-86400)*1000 ORDER BY settled_at DESC;"
echo
echo "=== 结算器巡检日志(60s tick) 最近 ==="
grep -a "质押日结\|stake.*settle\|processAll" /opt/wg-platform/logs/server.stdout.log | tail -10 || echo "(无质押结算日志)"
echo
echo "=== 服务启动时间与质押任务启动日志 ==="
grep -a "质押" /opt/wg-platform/logs/server.stdout.log | head -20 || true
echo
echo "=== 全站质押 active 统计 ==="
sqlite3 -header "$DB" "SELECT plan_id, status, COUNT(*) AS cnt FROM a_token_stakes GROUP BY plan_id, status ORDER BY plan_id, status;"
