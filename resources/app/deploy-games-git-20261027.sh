set -e
SHA=a7af3ee1ccc79d743a1e182113fdd772b9149f1b
APP=/opt/wg-platform
BK=$APP/backups/games-20261027
mkdir -p "$BK"
for f in src/server.js src/database.js public/games.html public/run-aix.html public/hash-aix.html; do
  if [ -f "$APP/$f" ]; then cp -a "$APP/$f" "$BK/$(echo "$f" | tr '/' '_')"; fi
done
echo "BACKUP_OK $BK"

rm -rf /tmp/axix-pull /tmp/axix-main.tar.gz
mkdir -p /tmp/axix-pull
curl -sL --max-time 300 "https://codeload.github.com/MEMEFANS/AXIX/tar.gz/$SHA" -o /tmp/axix-main.tar.gz
echo "DOWNLOAD_BYTES $(stat -c %s /tmp/axix-main.tar.gz)"
tar -xzf /tmp/axix-main.tar.gz -C /tmp/axix-pull
SRC=/tmp/axix-pull/AXIX-$SHA/resources/app
[ -f "$SRC/public/games.html" ] || { echo "MISSING_SRC"; exit 1; }

cp -a "$SRC/public/games" "$APP/public/"
cp -a "$SRC/public/games.html" "$SRC/public/run-aix.html" "$SRC/public/hash-aix.html" "$SRC/public/run-aix-classic.html" "$SRC/public/run-aix-config.html" "$APP/public/"
cp -a "$SRC/src/server.js" "$SRC/src/database.js" "$SRC/src/run-aix-game-api.js" "$SRC/src/hash-aix-game-api.js" "$APP/src/"
echo "COPY_OK"
find "$APP/public/games" -type f | wc -l

cd "$APP"
for f in src/server.js src/database.js src/run-aix-game-api.js src/hash-aix-game-api.js; do
  node --check "$f" && echo "SYNTAX_OK $f"
done

systemctl restart wg-platform
ok=0
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8082/api/a-token/plans 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then echo "READY after ${i}x3s"; ok=1; break; fi
  sleep 3
done
[ "$ok" = "1" ] || { echo "NOT_READY"; tail -20 "$APP/logs/server.stderr.log"; exit 1; }

echo "=== 静态页 ==="
for p in /games.html /run-aix.html /hash-aix.html /games/lobby/lobby.js /games/run-aix/adventure.js /games/hash-aix/main.js /games/run-aix/assets/hero-v2.png; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:8082$p")
  echo "$p -> $code"
done

echo "=== iframe 头 ==="
curl -sI -m 5 http://127.0.0.1:8082/games.html | grep -Ei 'x-frame-options|content-security-policy'

echo "=== 游戏接口注册（401=需要登录，404=未注册）==="
for p in /api/run-aix/state /api/hash-aix/state; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:8082$p")
  echo "$p -> $code"
done

echo "=== 账本表 ==="
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('$APP/wg-platform.sqlite');console.log(db.prepare(\"select name from sqlite_master where type='table' and name like '%aix%'\").all().map(r=>r.name).join(','));"

systemctl is-active wg-platform
