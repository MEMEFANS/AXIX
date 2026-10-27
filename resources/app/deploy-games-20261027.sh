set -e
cd /opt/wg-platform
BK=/opt/wg-platform/backups/games-20261027
mkdir -p "$BK"
for f in src/server.js src/database.js public/games.html public/run-aix.html public/hash-aix.html; do
  [ -f "$f" ] && cp -a "$f" "$BK/$(echo "$f" | tr '/' '_')"
done
echo "backup -> $BK"
ls -l "$BK"

# 分片重组
cat /tmp/axix-parts/part_000 /tmp/axix-parts/part_001 /tmp/axix-parts/part_002 /tmp/axix-parts/part_003 \
    /tmp/axix-parts/part_004 /tmp/axix-parts/part_005 /tmp/axix-parts/part_006 /tmp/axix-parts/part_007 \
    /tmp/axix-parts/part_008 /tmp/axix-parts/part_009 /tmp/axix-parts/part_010 /tmp/axix-parts/part_011 \
    > /tmp/axix-games.tar.gz
ACTUAL=$(md5sum /tmp/axix-games.tar.gz | awk '{print $1}')
EXPECT=${EXPECT_MD5:-4cafe95c4746420d77959f78883d0a4f}
if [ "$ACTUAL" != "$EXPECT" ]; then echo "MD5_MISMATCH expect=$EXPECT actual=$ACTUAL"; exit 1; fi
echo "ARCHIVE_MD5_OK $ACTUAL"

tar -xzf /tmp/axix-games.tar.gz -C /opt/wg-platform
echo "extracted"
ls -l public/games.html public/run-aix.html public/hash-aix.html src/run-aix-game-api.js src/hash-aix-game-api.js
find public/games -type f | wc -l
