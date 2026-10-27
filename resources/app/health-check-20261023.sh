echo "=== 1) 服务与端口 ==="
systemctl is-active wg-platform
systemctl status wg-platform --no-pager -n 0 | head -n 6
PID=$(pidof node); echo "node PID=$PID"
ps -o pid,etime,%cpu,rss -p "$PID" 2>/dev/null | tail -n 1
curl -s -o /dev/null -w "local_8082_plans=%{time_total}s http=%{http_code}\n" -m 10 "http://127.0.0.1:8082/api/a-token/plans"
systemctl is-active nginx
curl -s -o /dev/null -w "via_nginx=%{time_total}s http=%{http_code}\n" -m 15 "https://axix.cc/api/a-token/plans"

echo ""
echo "=== 2) 系统负载 ==="
uptime
free -m | head -n 2

echo ""
echo "=== 3) nginx 最近 5 分钟状态码分布 ==="
find /var/log/nginx -name "access.log" -mmin -5 >/dev/null 2>&1
tail -n 500 /var/log/nginx/access.log | awk '{print $9}' | sort | uniq -c | sort -rn | head -n 12
echo "--- 最近 10 条非 200 ---"
tail -n 500 /var/log/nginx/access.log | awk '$9!=200 && $9!=304' | tail -n 10

echo ""
echo "=== 4) nginx error log 尾部 ==="
tail -n 15 /var/log/nginx/error.log 2>/dev/null

echo ""
echo "=== 5) 应用日志尾部 ==="
echo "--- stderr ---"
tail -n 20 /opt/wg-platform/logs/server.stderr.log
echo "--- stdout ---"
tail -n 10 /opt/wg-platform/logs/server.stdout.log
