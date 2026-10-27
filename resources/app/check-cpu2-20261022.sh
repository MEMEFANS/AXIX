sleep 120
PID=$(pidof node)
echo "--- after 2min settle, samples every 5s x6 ---"
for i in 1 2 3 4 5 6; do
  top -bn1 -p "$PID" 2>/dev/null | grep -E "^\s*$PID"
  sleep 5
done
echo "--- uptime ---"
ps -o pid,etime,%cpu,cmd -p "$PID" | tail -n 1
echo "--- api spot check ---"
for i in 1 2 3; do
  curl -s -o /dev/null -w "plans_%{time_total}s http=%{http_code}\n" -m 30 "http://127.0.0.1:8082/api/a-token/plans"
  sleep 2
done
