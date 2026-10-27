echo "=== 服务器上 run-aix 相关文件 ==="
ls -la /opt/wg-platform/public/run-aix*.html 2>/dev/null || echo "no run-aix pages"
ls /opt/wg-platform/public/games/ 2>/dev/null || echo "no games dir"
echo ""
echo "=== 服务器 index.html 游戏引用行 ==="
grep -n "run-aix\|openRunAix" /opt/wg-platform/public/index.html || echo "index.html 无游戏引用"
echo ""
echo "=== 当前站点健康快照 ==="
curl -s -o /dev/null -w "local_plans=%{time_total}s http=%{http_code}\n" -m 10 "http://127.0.0.1:8082/api/a-token/plans"
curl -s -o /dev/null -w "index=%{time_total}s http=%{http_code}\n" -m 10 "https://axix.cc/"
awk -v since="$(date -d '10 minutes ago' '+[%d/%b/%Y:%H:%M')" '$4 >= since && ($9=="499" || $9 ~ /^5/) {c[$9]++} END {for (k in c) print "status", k, c[k]}' /var/log/nginx/access.log
echo "=== 近 10 分钟请求量 ==="
awk -v since="$(date -d '10 minutes ago' '+[%d/%b/%Y:%H:%M')" '$4 >= since' /var/log/nginx/access.log | wc -l
