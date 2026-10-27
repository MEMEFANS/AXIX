set -e
# 等端口就绪（最多 120s）
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "http://127.0.0.1:8082/api/a-token/plans" || true)
  if [ "$code" != "000" ]; then echo "PORT_READY after ~$((i*2))s http=$code"; break; fi
  sleep 2
done

# API 延迟（修复前 plans 1.9~18.5s、静态 8s）
for i in 1 2 3; do
  curl -s -o /dev/null -w "plans_${i}=%{time_total}s http=%{http_code}\n" -m 30 "http://127.0.0.1:8082/api/a-token/plans"
done
curl -s -o /dev/null -w "home=%{time_total}s http=%{http_code}\n" -m 30 "http://127.0.0.1:8082/"
curl -s -o /dev/null -w "pool=%{time_total}s http=%{http_code}\n" -m 30 "http://127.0.0.1:8082/api/a-token/pool"
curl -s -o /dev/null -w "kline=%{time_total}s http=%{http_code}\n" -m 30 "http://127.0.0.1:8082/api/a-token/klines?interval=1h&limit=24"

# CPU 采样（修复前恒定 ~91%）
PID=$(pidof node)
for i in 1 2 3; do
  top -bn1 -p "$PID" | tail -n 2 | head -n 1
  sleep 3
done

# inspector 应已消失
ss -lntp | grep 9229 || echo "INSPECTOR_GONE"

# stderr 重启后新错误检查
echo "--- stderr tail ---"
tail -n 5 /opt/wg-platform/logs/server.stderr.log
echo "--- stdout tail ---"
tail -n 5 /opt/wg-platform/logs/server.stdout.log
