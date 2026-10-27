#!/bin/bash
cd /opt/wg-platform
node --check src/server.js && node --check src/wallet-service.js && echo "syntax OK"
systemctl restart wg-platform.service
echo "restarted at $(date '+%F %T')"
ok=0
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8082/api/a-token/plans 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then echo "ready after ${i}x5s"; ok=1; break; fi
  sleep 5
done
[ "$ok" = "1" ] || { echo "NOT READY"; tail -20 /opt/wg-platform/logs/server.stderr.log; exit 1; }
echo
echo "=== 新接口代查旧充值地址余额 ==="
curl -s "http://127.0.0.1:8082/api/wallet/deposit-balance?address=0xa71e0cfb92643ccf1fadcd45fcfb29b7b39c56e6"
echo
echo "=== 非法地址拦截 ==="
curl -s "http://127.0.0.1:8082/api/wallet/deposit-balance?address=abc"
echo
echo "=== 服务状态 ==="
systemctl is-active wg-platform.service
tail -2 /opt/wg-platform/logs/server.stdout.log
