set -e
ENVF=/var/lib/wg-platform/.env
U=$(grep -E '^PLATFORM_ADMIN_USERNAME=' "$ENVF" | head -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
P=$(grep -E '^PLATFORM_ADMIN_PASSWORD=' "$ENVF" | head -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
if [ -z "$U" ] || [ -z "$P" ]; then echo "NO_CREDENTIALS"; exit 1; fi
BASE="http://127.0.0.1:8082"
CJ=/tmp/admin-cookie.txt
rm -f "$CJ"

echo "=== 0) operator 登录 ==="
code=$(curl -s -m 30 -c "$CJ" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$U\",\"password\":\"$P\"}" \
  -o /tmp/login-resp.json -w "%{http_code}" "$BASE/api/admin/login")
echo "login http=$code $(cat /tmp/login-resp.json | head -c 200)"
if [ "$code" != "200" ]; then exit 1; fi

echo ""
echo "=== 1) 当前挂单预览 ==="
curl -s -m 60 -b "$CJ" "$BASE/api/admin/a-token/orders" -o /tmp/orders-before.json
node -e '
const d = JSON.parse(require("fs").readFileSync("/tmp/orders-before.json","utf8"));
const items = d.items || [];
console.log("stats_before:", JSON.stringify(d.stats));
console.log("open_count:", items.length);
for (const o of items) {
  const usdt = Number(o.input_usdt_units||0)/1e6, a = Number(o.input_a_units||0)/1e18;
  console.log(`  ${o.id} ${String(o.side).padEnd(4)} ${String(o.order_type).padEnd(6)} ${o.status} wallet=${String(o.wallet).slice(0,10)}... 锁定${usdt>0?usdt.toFixed(2)+" USDT":""}${a>0?a.toFixed(2)+" A":""}`);
}'

echo ""
echo "=== 2) 逐单撤单 ==="
IDS=$(node -e 'const d=JSON.parse(require("fs").readFileSync("/tmp/orders-before.json","utf8"));for(const o of (d.items||[]))console.log(o.id)')
ok=0; fail=0
for id in $IDS; do
  code=$(curl -s -m 60 -b "$CJ" -H 'Content-Type: application/json' \
    -d "{\"orderId\":\"$id\",\"reason\":\"admin_cancel_all_20261023\"}" \
    -o /tmp/cancel-resp.json -w "%{http_code}" \
    "$BASE/api/admin/a-token/orders/cancel")
  if [ "$code" = "200" ]; then
    ok=$((ok+1)); echo "  OK $id $(cat /tmp/cancel-resp.json)"
  else
    fail=$((fail+1)); echo "  FAIL $id http=$code $(cat /tmp/cancel-resp.json | head -c 200)"
  fi
done
echo "cancelled=$ok failed=$fail"

echo ""
echo "=== 3) 复核 ==="
curl -s -m 60 -b "$CJ" "$BASE/api/admin/a-token/orders" -o /tmp/orders-after.json
node -e '
const d = JSON.parse(require("fs").readFileSync("/tmp/orders-after.json","utf8"));
console.log("stats_after:", JSON.stringify(d.stats));
console.log("remaining_open:", (d.items||[]).length);
for (const o of (d.items||[])) console.log("  STILL OPEN:", o.id, o.side, o.status);'

echo ""
echo "=== 4) 登出 ==="
curl -s -m 30 -b "$CJ" -X POST "$BASE/api/admin/logout" -o /dev/null -w "logout http=%{http_code}\n"
rm -f "$CJ"
