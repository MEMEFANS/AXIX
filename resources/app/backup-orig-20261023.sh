#!/bin/bash
set -e
cd /opt/wg-platform
BK=/opt/wg-platform/backups/matchn30-20261023
mkdir -p "$BK"
rm -f "$BK"/*.after
cp src/a-token-order-service.js "$BK/a-token-order-service.js.orig"
cp src/a-token-team-service.js  "$BK/a-token-team-service.js.orig"
cp src/server.js                "$BK/server.js.orig"
echo "=== 原版备份（改动前）==="
ls -l "$BK"
md5sum "$BK"/*.orig
