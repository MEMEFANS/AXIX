echo "=== stderr since restart: error/referral lines ==="
grep -iE "referral|error|throw" /opt/wg-platform/logs/server.stderr.log | tail -n 10 || echo "NONE"
echo ""
echo "=== nginx last 200 requests: referral & a-token & plans status ==="
tail -n 200 /var/log/nginx/access.log | awk '{print $9}' | sort | uniq -c
echo ""
echo "=== referral endpoints in nginx tail ==="
tail -n 500 /var/log/nginx/access.log | grep -E "/api/referrals" | tail -n 5 || echo "no referral hits in tail"
echo ""
echo "=== CPU final sample ==="
PID=$(pidof node)
for i in 1 2 3; do
  top -bn1 -p "$PID" 2>/dev/null | grep -E "^\s*$PID"
  sleep 4
done
echo ""
echo "=== uptime + memory ==="
ps -o pid,etime,%cpu,rss -p "$PID" | tail -n 1
free -m | head -n 2
