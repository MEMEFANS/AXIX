#!/bin/bash
echo "=== 静态资源 vs 各接口延迟对比（各 2 次） ==="
for i in 1 2; do curl -s -o /dev/null -w "/static: %{time_total}s\n" http://127.0.0.1:8082/admin.html; done
for i in 1 2; do curl -s -o /dev/null -w "/api/a-token/plans: %{time_total}s\n" http://127.0.0.1:8082/api/a-token/plans; done
for i in 1 2; do curl -s -o /dev/null -w "/api/a-token/pool: %{time_total}s\n" http://127.0.0.1:8082/api/a-token/pool; done
for i in 1 2; do curl -s -o /dev/null -w "/api/announcement: %{time_total}s\n" http://127.0.0.1:8082/api/announcement; done
echo "=== a_token_activations 表规模 ==="
sqlite3 "file:///var/lib/wg-platform/wg-platform.sqlite?mode=ro" "SELECT COUNT(*) FROM a_token_activations;"
echo "=== countConfirmedATokenActivations 的 SQL（看是否全表扫） ==="
grep -n 'countConfirmedATokenActivations' /opt/wg-platform/src/database.js | head -3
echo "=== node CPU 现状 ==="
ps -o %cpu,time -p $(pidof node) | tail -1
