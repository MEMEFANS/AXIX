#!/bin/bash
cd /opt/wg-platform
echo "=== 重启前 CPU/负载 ==="
uptime
echo
echo "=== 重启 wg-platform ==="
systemctl restart wg-platform.service
echo "restarted at $(date '+%F %T')"
echo
echo "=== 轮询等端口 8082（最多 150s）==="
ok=0
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8082/api/health 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then echo "health 200 after ${i}x5s"; ok=1; break; fi
  sleep 5
done
[ "$ok" = "1" ] || { echo "端口超时未就绪！"; tail -30 /opt/wg-platform/logs/server.stderr.log; exit 1; }
echo
echo "=== 关键接口抽测 ==="
curl -s -o /dev/null -w 'plans=%{http_code} %{time_total}s\n' http://127.0.0.1:8082/api/a-token/plans
curl -s -o /dev/null -w 'pool=%{http_code} %{time_total}s\n' http://127.0.0.1:8082/api/a-token/pool
curl -s -o /dev/null -w 'orders=%{http_code} %{time_total}s\n' http://127.0.0.1:8082/api/a-token/orders
echo
echo "=== 启动日志尾部 ==="
tail -5 /opt/wg-platform/logs/server.stdout.log
tail -3 /opt/wg-platform/logs/server.stderr.log
echo
echo "=== 进程与负载 ==="
systemctl is-active wg-platform.service
uptime
