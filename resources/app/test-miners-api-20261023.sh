ENVF=/var/lib/wg-platform/.env
U=$(grep -E '^PLATFORM_ADMIN_USERNAME=' "$ENVF" | head -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
P=$(grep -E '^PLATFORM_ADMIN_PASSWORD=' "$ENVF" | head -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
BASE="http://127.0.0.1:8082"
CJ=/tmp/admin-cookie2.txt
rm -f "$CJ"
curl -s -m 30 -c "$CJ" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$U\",\"password\":\"$P\"}" \
  -o /dev/null -w "login=%{http_code}\n" "$BASE/api/admin/login"
curl -s -m 60 -b "$CJ" "$BASE/api/admin/a-token/miners?limit=1" -o /tmp/miners.json
node -e '
const d = JSON.parse(require("fs").readFileSync("/tmp/miners.json","utf8"));
console.log("today field =", JSON.stringify(d.today));
console.log("summary keys =", d.summary ? Object.keys(d.summary).join(",") : "null");'
curl -s -m 30 -b "$CJ" -X POST "$BASE/api/admin/logout" -o /dev/null
rm -f "$CJ"
