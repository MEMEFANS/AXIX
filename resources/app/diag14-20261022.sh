#!/bin/bash
DB="sqlite3 file:///var/lib/wg-platform/wg-platform.sqlite?mode=ro"
echo "=== 1. minerStats 全表扫（pool 接口每次调用） ==="
time $DB "SELECT plan, daily_target_units, total_earned_units, total_units FROM a_token_miners WHERE status='active';" > /dev/null
echo "=== 2. 激活计数（plans 接口每次调用） ==="
time $DB "SELECT COUNT(*) FROM a_token_activations WHERE status='confirmed';"
echo "=== 3. listReferralLinks（快照/团队页每次） ==="
time $DB "SELECT payload_json FROM platform_referral_links;" > /dev/null
echo "=== 4. listDueATokenMiners（矿机定时器每 60s） ==="
time $DB "SELECT payload_json FROM a_token_miners WHERE status='active' AND (last_release_at < 1792512000000 OR expires_at <= 1792600000000) ORDER BY expires_at;" > /dev/null
echo "=== 5. listATokenKlines 1h x26（pool 接口 changePct24h） ==="
time $DB "SELECT payload_json FROM a_token_klines WHERE period='1h' ORDER BY time DESC LIMIT 26;" > /dev/null
echo "=== 6. 平台用户 payload 全表（wallet_users 场景参考） ==="
time $DB "SELECT payload_json FROM wallet_users;" > /dev/null
echo "=== 执行计划：minerStats 查询 ==="
$DB "EXPLAIN QUERY PLAN SELECT plan, daily_target_units, total_earned_units, total_units FROM a_token_miners WHERE status='active';"
