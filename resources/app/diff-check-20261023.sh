#!/bin/bash
cd /opt/wg-platform || exit 1
echo "=== diff order-service vs 20261017 备份（应只含本次改动）==="
diff /opt/wg-platform/backups/sync-20261017-034523/src/a-token-order-service.js src/a-token-order-service.js | head -40
echo
echo "=== 最近 team-service 备份 ==="
ls -lt /opt/wg-platform/backups/*/src/a-token-team-service.js 2>/dev/null | head -3
LATEST=$(ls -t /opt/wg-platform/backups/*/src/a-token-team-service.js 2>/dev/null | head -1)
echo "latest=$LATEST"
echo "=== diff team-service vs 最新备份 ==="
diff "$LATEST" src/a-token-team-service.js | head -30
echo
echo "=== 最近 server.js 备份 ==="
ls -lt /opt/wg-platform/backups/*/src/server.js 2>/dev/null | head -2
