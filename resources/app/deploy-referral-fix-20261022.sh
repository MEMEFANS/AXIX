set -e
EXPECT_MD5="f3f2da75d987733682acb733831f9923"
ACTUAL_MD5=$(md5sum /opt/wg-platform/src/referral-service.js | awk '{print $1}')
if [ "$EXPECT_MD5" != "$ACTUAL_MD5" ]; then
  echo "MD5_MISMATCH expect=$EXPECT_MD5 actual=$ACTUAL_MD5"
  exit 1
fi
echo "MD5_OK"
node --check /opt/wg-platform/src/referral-service.js && echo "SYNTAX_OK"

systemctl restart wg-platform
# 等端口就绪（最多 120s）
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "http://127.0.0.1:8082/api/a-token/plans" || true)
  if [ "$code" != "000" ]; then echo "PORT_READY http=$code"; break; fi
  sleep 2
done
systemctl is-active wg-platform && echo "SERVICE_ACTIVE"

# 静置 90 秒让启动预热完成，再采样
sleep 90
PID=$(pidof node)
echo "--- CPU samples (every 5s x 8) ---"
for i in 1 2 3 4 5 6 7 8; do
  top -bn1 -p "$PID" 2>/dev/null | grep -E "^\s*$PID" || true
  sleep 5
done
echo "--- API spot checks ---"
for i in 1 2 3 4; do
  curl -s -o /dev/null -w "plans_%{time_total}s http=%{http_code}\n" -m 30 "http://127.0.0.1:8082/api/a-token/plans"
  sleep 2
done
curl -s -o /dev/null -w "home=%{time_total}s http=%{http_code}\n" -m 30 "http://127.0.0.1:8082/"
echo "--- inspector check ---"
ss -lntp | grep 9229 || echo "INSPECTOR_GONE"
echo "--- stderr tail ---"
tail -n 5 /opt/wg-platform/logs/server.stderr.log
