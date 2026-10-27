set -e
EXPECT_MD5="80a6b34f816c64e52e0b7c44b25e2b28"
ACTUAL_MD5=$(md5sum /opt/wg-platform/src/wallet-service.js | awk '{print $1}')
if [ "$EXPECT_MD5" != "$ACTUAL_MD5" ]; then
  echo "MD5_MISMATCH expect=$EXPECT_MD5 actual=$ACTUAL_MD5"
  exit 1
fi
echo "MD5_OK"

node --check /opt/wg-platform/src/wallet-service.js
echo "SYNTAX_OK"

# 重启服务（顺带清掉 SIGUSR1 激活的 inspector 端口 9229）
systemctl restart wg-platform
sleep 8
systemctl is-active wg-platform && echo "SERVICE_ACTIVE"

# 启动日志尾部：确认无新错误
tail -n 15 /opt/wg-platform/logs/server.stderr.log

# API 延迟验证（修复前 plans 1.9~18.5s）
for i in 1 2 3; do
  curl -s -o /dev/null -w "plans_${i}=%{time_total}s http=%{http_code}\n" -m 30 "http://127.0.0.1:8082/api/a-token/plans"
done
curl -s -o /dev/null -w "home=%{time_total}s http=%{http_code}\n" -m 30 "http://127.0.0.1:8082/"
curl -s -o /dev/null -w "pool=%{time_total}s http=%{http_code}\n" -m 30 "http://127.0.0.1:8082/api/a-token/pool"

# CPU 采样（修复前主线程恒定 ~99.9%，进程整体 ~91%）
for i in 1 2 3; do
  top -bn1 -p $(pidof node) | tail -n 2
  sleep 2
done
