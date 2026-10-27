#!/bin/bash
DB=/var/lib/wg-platform/wg-platform.sqlite
W=0x79b8cee7fb9724e3edb1c7e41bb353873df512e4
echo "=== 矿机 ==="
sqlite3 -header "$DB" "SELECT id, plan, status, datetime(started_at/1000,'unixepoch','+8 hours') AS started_bj, datetime(last_release_at/1000,'unixepoch','+8 hours') AS last_release_bj, printf('%.2f',CAST(total_released_units AS REAL)/1e18) AS released_A FROM a_token_miners WHERE lower(wallet)='$W' ORDER BY started_at DESC LIMIT 20;" 2>/dev/null || sqlite3 -header "$DB" "SELECT * FROM a_token_miners WHERE lower(wallet)='$W' LIMIT 3;"
echo
echo "=== 矿机最近发放 ==="
sqlite3 -header "$DB" "SELECT COUNT(*) AS cnt, printf('%.2f',SUM(CAST(amount_units AS REAL)/1e18)) AS total_A, datetime(MAX(released_at)/1000,'unixepoch','+8 hours') AS last_bj FROM a_token_miner_releases WHERE lower(wallet)='$W';"
echo
echo "=== 团队分润 ==="
sqlite3 -header "$DB" "SELECT kind, COUNT(*) AS cnt, printf('%.4f',SUM(CAST(amount_units AS REAL)/1e18)) AS total_A, datetime(MAX(created_at)/1000,'unixepoch','+8 hours') AS last_bj FROM a_token_team_rewards WHERE lower(recipient_wallet)='$W' GROUP BY kind;"
echo
echo "=== 该用户质押 s60 的扣款时刻前后 A 余额变动佐证（钱包流水如有） ==="
sqlite3 -header "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%ledger%' OR name LIKE '%flow%' OR name LIKE '%balance%');"
echo
echo "=== balance_adjustments 里是否有该地址 ==="
sqlite3 -header "$DB" "SELECT COUNT(*) FROM balance_adjustments WHERE lower(wallet)='$W';" 2>/dev/null || true
echo
echo "=== s60 质押前后：activation 记录（是否买矿机顺带质押） ==="
sqlite3 -header "$DB" "SELECT id, plan_key, status, datetime(created_at/1000,'unixepoch','+8 hours') AS created_bj FROM a_token_activations WHERE lower(wallet)='$W' ORDER BY created_at DESC LIMIT 10;" 2>/dev/null || true
