#!/bin/bash
PID=$(pidof node)
echo "=== 主线程调用栈抓取（3 次，间隔 4 秒） ==="
for i in 1 2 3; do
  echo "--- 第 $i 次 ---"
  timeout 10 gdb -p $PID -batch -ex 'set pagination off' -ex 'thread 1' -ex 'bt 18' 2>/dev/null | grep -E '^#' | head -18
  sleep 4
done
