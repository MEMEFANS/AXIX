echo "=== nginx error log 带时间戳（最近 30 行）==="
tail -n 30 /var/log/nginx/error.log 2>/dev/null | sed 's/^/  /'
echo ""
echo "=== 应用 stderr 最近 30 行 ==="
tail -n 30 /opt/wg-platform/logs/server.stderr.log
echo ""
echo "=== 应用 stdout 最近 20 行 ==="
tail -n 20 /opt/wg-platform/logs/server.stdout.log
echo ""
echo "=== 最近 15 分钟各分钟 499/5xx 数量 ==="
awk -v since="$(date -d '15 minutes ago' '+[%d/%b/%Y:%H:%M')" '$4 >= since && ($9=="499" || $9 ~ /^5/) {print substr($4,2,17)}' /var/log/nginx/access.log | sort | uniq -c
echo ""
echo "=== games 目录检查 ==="
ls -la /opt/wg-platform/public/games/ 2>/dev/null || echo "NO /opt/wg-platform/public/games/"
ls /opt/wg-platform/public/games/run-aix/ 2>/dev/null || echo "NO run-aix dir"
find /opt/wg-platform/public -iname "*launcher*" 2>/dev/null | head -n 5
echo ""
echo "=== 21:26 以来请求总量（活跃度）==="
awk -v since="[23/Oct/2026:21:26" '$4 >= since' /var/log/nginx/access.log | wc -l
