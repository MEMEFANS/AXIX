#!/bin/bash
PID=$(pidof node)
echo "=== node 全部对外连接（按状态+目标统计） ==="
ss -tnp 2>/dev/null | grep "pid=$PID" | awk '{print $1, $5}' | sed 's/:[0-9]*$//' | sort | uniq -c | sort -rn | head -12
echo "=== 对外 443 连接总数 ==="
ss -tnp 2>/dev/null | grep "pid=$PID" | grep -c ':443 '
echo "=== 源码里币安 WS/行情订阅（连接管理） ==="
grep -rn 'wss://\|WebSocket\|fstream\|stream.binance' /opt/wg-platform/src/*.js | head -10
