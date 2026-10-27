#!/bin/bash
DB="sqlite3 file:///var/lib/wg-platform/wg-platform.sqlite?mode=ro"
echo "=== 数据规模 ==="
echo -n "referral_links 用户数: "; $DB "SELECT COUNT(*) FROM platform_referral_links;"
echo -n "活跃矿机: "; $DB "SELECT COUNT(*) FROM a_token_miners WHERE status='active';"
echo -n "矿机总数: "; $DB "SELECT COUNT(*) FROM a_token_miners;"
echo -n "质押数: "; $DB "SELECT COUNT(*) FROM a_token_stakes WHERE status='active';"
echo "=== 23:31 重启原因（journalctl） ==="
journalctl -u wg-platform --since "2026-10-21 23:25" --until "2026-10-21 23:35" --no-pager 2>/dev/null | grep -v '^--' | head -8
echo "=== 对账日志行数与最近内容 ==="
grep -c '对账' /opt/wg-platform/logs/server.stdout.log
grep '对账' /opt/wg-platform/logs/server.stdout.log | tail -3
echo "=== 日结日志（今日 0 点） ==="
grep -E '平级奖日结|A10池日结|矿机.*产出|质押.*产出' /opt/wg-platform/logs/server.stdout.log | tail -6
echo "=== 延迟探测（15 次 x 1s） ==="
for i in $(seq 1 15); do curl -s -o /dev/null -w "%{time_total}\n" http://127.0.0.1:8082/api/a-token/plans; sleep 1; done
