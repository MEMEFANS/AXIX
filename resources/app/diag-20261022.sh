#!/bin/bash
echo "=== 时间/负载 ==="
date '+%F %T'; uptime
echo "=== CPU 前 5 进程 ==="
ps aux --sort=-%cpu | head -6 | awk '{printf "%-10s %5s%% %5s%% %s\n", $1, $3, $4, $11}'
echo "=== 服务状态 ==="
systemctl is-active wg-platform
echo "=== API 延迟 ==="
for i in 1 2 3; do curl -s -o /dev/null -w "plans: %{time_total}s\n" http://127.0.0.1:8082/api/a-token/plans; done
curl -s -o /dev/null -w "home: %{http_code} %{time_total}s\n" http://127.0.0.1:8082/
echo "=== K 线 tick（最近 3 条） ==="
grep '\[A币K线\] tick ok' /opt/wg-platform/logs/server.stdout.log | tail -3
echo "=== 对账日志（最近 2 条） ==="
grep '\[A币激活\]\[对账\]' /opt/wg-platform/logs/server.stdout.log | tail -2
echo "=== stderr 最近 10 行 ==="
tail -10 /opt/wg-platform/logs/server.stderr.log
echo "=== stdout 最近 6 行 ==="
tail -6 /opt/wg-platform/logs/server.stdout.log
