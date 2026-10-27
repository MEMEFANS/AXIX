set -e
ENVF=/var/lib/wg-platform/.env
U=$(grep -E '^PLATFORM_ADMIN_USERNAME=' "$ENVF" | head -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
P=$(grep -E '^PLATFORM_ADMIN_PASSWORD=' "$ENVF" | head -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
BASE="http://127.0.0.1:8082"
CJ=/tmp/admin-cookie4.txt
rm -f "$CJ" /tmp/cancel-all.log /tmp/cancel-done.flag /tmp/order-ids.txt

curl -s -m 30 -c "$CJ" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$U\",\"password\":\"$P\"}" \
  -o /dev/null -w "login=%{http_code}\n" "$BASE/api/admin/login"

curl -s -m 60 -b "$CJ" "$BASE/api/admin/a-token/orders" -o /tmp/orders-before.json
node -e '
const d = JSON.parse(require("fs").readFileSync("/tmp/orders-before.json","utf8"));
const items = d.items || [];
console.log("open_count:", items.length, "stats:", JSON.stringify(d.stats));
require("fs").writeFileSync("/tmp/order-ids.txt", items.map(o => o.id).join("\n") + "\n");'

cat > /tmp/cancel-loop.sh <<'EOF'
#!/bin/bash
CJ=/tmp/admin-cookie4.txt
BASE="http://127.0.0.1:8082"
ok=0; fail=0
while read -r id; do
  [ -z "$id" ] && continue
  code=$(curl -s -m 30 -b "$CJ" -H 'Content-Type: application/json' \
    -d "{\"orderId\":\"$id\",\"reason\":\"admin_cancel_all_20261023\"}" \
    -o /tmp/cancel-resp.json -w "%{http_code}" \
    "$BASE/api/admin/a-token/orders/cancel")
  if [ "$code" = "200" ]; then ok=$((ok+1)); echo "OK $id"
  else fail=$((fail+1)); echo "FAIL $id http=$code $(cat /tmp/cancel-resp.json | head -c 120)"; fi
done < /tmp/order-ids.txt
echo "DONE cancelled=$ok failed=$fail"
touch /tmp/cancel-done.flag
EOF
chmod +x /tmp/cancel-loop.sh
nohup /tmp/cancel-loop.sh > /tmp/cancel-all.log 2>&1 &
echo "loop started pid=$!"

TOTAL=$(wc -l < /tmp/order-ids.txt)
for i in $(seq 1 90); do
  if [ -f /tmp/cancel-done.flag ]; then echo "LOOP_FINISHED"; break; fi
  sleep 10
  echo "progress: $(grep -c '^OK ' /tmp/cancel-all.log 2>/dev/null || echo 0) / $TOTAL"
done

tail -n 3 /tmp/cancel-all.log
