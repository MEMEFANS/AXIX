set -e
EXPECT_MD5="d8ae32059ed855279428f0fe11dbcdbf"
ACTUAL_MD5=$(md5sum /opt/wg-platform/src/a-token-admin-api.js | awk '{print $1}')
if [ "$EXPECT_MD5" != "$ACTUAL_MD5" ]; then echo "MD5_MISMATCH expect=$EXPECT_MD5 actual=$ACTUAL_MD5"; exit 1; fi
echo "MD5_OK"
node --check /opt/wg-platform/src/a-token-admin-api.js && echo "SYNTAX_OK"

systemctl restart wg-platform
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "http://127.0.0.1:8082/api/a-token/plans" || true)
  if [ "$code" != "000" ]; then echo "PORT_READY http=$code"; break; fi
  sleep 2
done
systemctl is-active wg-platform && echo "SERVICE_ACTIVE"

ENVF=/var/lib/wg-platform/.env
U=$(grep -E '^PLATFORM_ADMIN_USERNAME=' "$ENVF" | head -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
P=$(grep -E '^PLATFORM_ADMIN_PASSWORD=' "$ENVF" | head -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
BASE="http://127.0.0.1:8082"
CJ=/tmp/admin-cookie3.txt
rm -f "$CJ"
curl -s -m 30 -c "$CJ" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$U\",\"password\":\"$P\"}" \
  -o /dev/null -w "login=%{http_code}\n" "$BASE/api/admin/login"

echo "=== 验证 today 字段（昨日功能修复）==="
curl -s -m 60 -b "$CJ" "$BASE/api/admin/a-token/miners?limit=1" -o /tmp/miners2.json
node -e '
const d = JSON.parse(require("fs").readFileSync("/tmp/miners2.json","utf8"));
console.log("today =", JSON.stringify(d.today));'

echo "=== 验证订单列表（本次修复）==="
curl -s -m 60 -b "$CJ" "$BASE/api/admin/a-token/orders" -o /tmp/orders-check.json
node -e '
const d = JSON.parse(require("fs").readFileSync("/tmp/orders-check.json","utf8"));
console.log("stats:", JSON.stringify(d.stats));
console.log("items_count:", (d.items||[]).length);
console.log("first 3:", (d.items||[]).slice(0,3).map(o => o.id+" "+o.side+" "+o.status).join(" | "));'

curl -s -m 30 -b "$CJ" -X POST "$BASE/api/admin/logout" -o /dev/null
rm -f "$CJ"
