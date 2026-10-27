#!/bin/bash
PID=$(pidof node)
MAIN=$(ls /proc/$PID/task | head -1)
echo "=== 主线程当前 syscall（5 次采样，间隔 2s） ==="
for i in 1 2 3 4 5; do
  echo "sample $i: $(cat /proc/$PID/task/$MAIN/syscall 2>/dev/null | awk '{print $1}')"
  sleep 2
done
echo "=== 主线程上下文切换计数 ==="
grep -E 'voluntary|nonvoluntary' /proc/$PID/task/$MAIN/status
echo "=== 嫌疑 SQL 原文 ==="
grep -n -A3 'listDueATokenMinersStmt\s*=\s*db.prepare' /opt/wg-platform/src/database.js | head -6
grep -n -A8 'function minerStats' /opt/wg-platform/src/database.js | head -10
grep -n -A3 'listReferralLinksStmt\s*=\s*db.prepare' /opt/wg-platform/src/database.js | head -6
