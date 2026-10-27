#!/bin/bash
# 6 分钟监控：日志行实时打时间戳 + CPU 采样，输出到 /tmp/monitor.log
PID=$(pidof node)
(
  tail -n0 -f /opt/wg-platform/logs/server.stdout.log | while IFS= read -r line; do
    echo "$(date +%H:%M:%S) LOG $line"
  done &
  TAILPID=$!
  END=$((SECONDS + 360))
  while [ $SECONDS -lt $END ]; do
    echo "$(date +%H:%M:%S) CPU $(ps -o %cpu= -p $PID)"
    sleep 3
  done
  kill $TAILPID 2>/dev/null
) > /tmp/monitor.log 2>&1 &
echo "monitor started: $!"
