PID=$(pidof node)
echo "node PID=$PID"
for i in 1 2 3 4; do
  top -bn1 -p "$PID" 2>/dev/null | grep -E "^\s*$PID" || top -bn1 | grep -E "node" | head -n 2
  sleep 3
done
# 主线程占用（修复前 99.9%）
top -H -bn1 -p "$PID" 2>/dev/null | grep -E "node" | head -n 5
echo "---"
# 分线程 CPU 时间快照
cat /proc/$PID/status | grep -E "Threads|VmRSS"
