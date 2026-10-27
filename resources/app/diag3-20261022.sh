#!/bin/bash
PID=$(pidof node)
echo "=== node 进程 CPU 时间 vs 运行时长 ==="
ps -o pid,etime,time,%cpu -p $PID
echo "=== 连续采样 CPU（2 次 x 5s） ==="
top -bn2 -d 5 -p $PID | grep node | tail -2
echo "=== 团队快照日志内容（最近 5 条） ==="
grep '团队快照' /opt/wg-platform/logs/server.stdout.log | tail -5
echo "=== 团队快照累计条数 ==="
grep -c '团队快照' /opt/wg-platform/logs/server.stdout.log
echo "=== stderr 增速（10 秒） ==="
A=$(wc -l < /opt/wg-platform/logs/server.stderr.log); sleep 10; B=$(wc -l < /opt/wg-platform/logs/server.stderr.log)
echo "10s 新增 $((B-A)) 行"
echo "=== node 连接数 ==="
ss -tn state established '( sport = :8082 )' | wc -l
echo "=== WAL 大小 ==="
ls -la /var/lib/wg-platform/wg-platform.sqlite* | awk '{print $5, $9}'
