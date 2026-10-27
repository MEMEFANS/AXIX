#!/bin/bash
echo "=== 核数/内存 ==="
nproc; free -m | head -2
echo "=== stdout 日志增速（10 秒） ==="
A=$(wc -l < /opt/wg-platform/logs/server.stdout.log); sleep 10; B=$(wc -l < /opt/wg-platform/logs/server.stdout.log)
echo "10s 新增 $((B-A)) 行"
echo "=== 最近 200 行里各模式出现次数 ==="
tail -200 /opt/wg-platform/logs/server.stdout.log | awk '{print $1}' | sort | uniq -c | sort -rn | head -8
echo "=== nginx 请求速率（10 秒） ==="
LOG=/var/log/nginx/access.log
[ -f "$LOG" ] || LOG=$(ls /var/log/nginx/*access*.log 2>/dev/null | head -1)
A2=$(wc -l < "$LOG"); sleep 10; B2=$(wc -l < "$LOG")
echo "10s 新增 $((B2-A2)) 个请求"
echo "=== nginx 最近热点接口 ==="
tail -300 "$LOG" | awk '{print $7}' | sort | uniq -c | sort -rn | head -10
echo "=== 币安切换频率（最近 2000 行 stderr） ==="
tail -2000 /opt/wg-platform/logs/server.stderr.log | grep -c '切回直连'
