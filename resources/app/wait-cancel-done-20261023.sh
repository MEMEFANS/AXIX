# 等循环完成（最多 5 分钟）
for i in $(seq 1 30); do
  [ -f /tmp/cancel-done.flag ] && { echo "DONE_FLAG_PRESENT"; break; }
  sleep 10
done
echo "ok=$(grep -c '^OK ' /tmp/cancel-all.log) fail=$(grep -c '^FAIL ' /tmp/cancel-all.log) total=$(wc -l < /tmp/order-ids.txt)"
tail -n 2 /tmp/cancel-all.log
grep '^FAIL' /tmp/cancel-all.log | head -n 10 || true

echo ""
echo "=== 复核：订单列表与统计 ==="
ENVF=/var/lib/wg-platform/.env
U=$(grep -E '^PLATFORM_ADMIN_USERNAME=' "$ENVF" | head -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
P=$(grep -E '^PLATFORM_ADMIN_PASSWORD=' "$ENVF" | head -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
BASE="http://127.0.0.1:8082"
CJ=/tmp/admin-cookie5.txt
rm -f "$CJ"
curl -s -m 30 -c "$CJ" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$U\",\"password\":\"$P\"}" \
  -o /dev/null -w "login=%{http_code}\n" "$BASE/api/admin/login"
curl -s -m 60 -b "$CJ" "$BASE/api/admin/a-token/orders" -o /tmp/orders-final.json
node -e '
const d = JSON.parse(require("fs").readFileSync("/tmp/orders-final.json","utf8"));
console.log("stats:", JSON.stringify(d.stats));
console.log("remaining_open:", (d.items||[]).length);
for (const o of (d.items||[]).slice(0,10)) console.log("  STILL OPEN:", o.id, o.side, o.order_type, "created=", new Date(Number(o.created_at)).toISOString());'
curl -s -m 30 -b "$CJ" -X POST "$BASE/api/admin/logout" -o /dev/null
rm -f "$CJ"
