#!/bin/bash
cd /opt/wg-platform
echo "=== 语法检查 ==="
node --check src/a-token-team-service.js && echo "OK team-service"
echo
echo "=== 改动点确认 ==="
grep -n "rateBps: 880\|rateBps: 7920\|8.8%" src/a-token-team-service.js | head -3
grep -c "8.8%" public/index.html public/promo-team.html public/infographic.html public/promo-guide.html public/promo-invite.html
grep -c "walletstatechange" public/js/wallet-funds.js
grep -n "depbal" public/index.html public/js/page-loader.js | head -3
echo
echo "=== 重启 wg-platform ==="
systemctl restart wg-platform.service
echo "restarted at $(date '+%F %T')"
echo
echo "=== 轮询等就绪（用 plans 接口，最多 150s）==="
ok=0
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8082/api/a-token/plans 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then echo "plans 200 after ${i}x5s"; ok=1; break; fi
  sleep 5
done
[ "$ok" = "1" ] || { echo "端口超时未就绪！"; tail -20 /opt/wg-platform/logs/server.stderr.log; exit 1; }
echo
echo "=== 接口抽测 ==="
curl -s -o /dev/null -w 'plans=%{http_code} %{time_total}s\n' http://127.0.0.1:8082/api/a-token/plans
curl -s -o /dev/null -w 'home=%{http_code} %{time_total}s\n' http://127.0.0.1:8082/
curl -s http://127.0.0.1:8082/ | grep -c "8.8%" 
echo "（首页 8.8% 出现次数）"
curl -s -o /dev/null -w 'axix.cc=%{http_code} %{time_total}s\n' --max-time 10 https://axix.cc/
echo
echo "=== 进程状态 ==="
systemctl is-active wg-platform.service
