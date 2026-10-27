#!/bin/bash
cd /opt/wg-platform
node --check src/a-token-team-service.js && echo "syntax OK"
systemctl restart wg-platform.service
echo "restarted at $(date '+%F %T')"
ok=0
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8082/api/a-token/plans 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then echo "ready after ${i}x5s"; ok=1; break; fi
  sleep 5
done
[ "$ok" = "1" ] || { echo "NOT READY"; tail -20 /opt/wg-platform/logs/server.stderr.log; exit 1; }
systemctl is-active wg-platform.service
curl -s -o /dev/null -w 'pool:%{http_code} %{time_total}s\n' http://127.0.0.1:8082/api/a-token/pool
