#!/bin/bash
PID=$(pidof node)
echo "=== perf record 采样（10 秒，99Hz） ==="
perf record -F 99 -p $PID -g -o /tmp/perf-node.data -- sleep 10 2>/dev/null
perf report -i /tmp/perf-node.data --stdio --no-children 2>/dev/null | grep -v '^#' | grep -v '^$' | head -25
echo "=== strace 调用计数（6 秒） ==="
timeout 6 strace -c -p $PID 2>&1 | tail -18
