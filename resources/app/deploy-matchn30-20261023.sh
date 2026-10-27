#!/bin/bash
set -e
BK=/opt/wg-platform/backups/matchn30-20261023
mkdir -p "$BK/src" "$BK/test"
echo "=== 备份现状（若已部署过则保留首次备份）==="
[ -f "$BK/src/a-token-order-service.js" ] || cp /opt/wg-platform/src/a-token-order-service.js "$BK/src/"
[ -f "$BK/src/a-token-team-service.js" ] || cp /opt/wg-platform/src/a-token-team-service.js "$BK/src/"
[ -f "$BK/src/server.js" ] || cp /opt/wg-platform/src/server.js "$BK/src/"
[ -f "$BK/test/a-token-match-priority.test.js" ] || cp /opt/wg-platform/test/a-token-match-priority.test.js "$BK/test/" 2>/dev/null || true
ls -l "$BK/src" "$BK/test" | head -20
echo
echo "=== 语法检查 ==="
cd /opt/wg-platform
node --check src/a-token-order-service.js && echo "order ok"
node --check src/a-token-team-service.js && echo "team ok"
node --check src/server.js && echo "server ok"
node --check test/a-token-match-priority.test.js && echo "test ok"
echo
echo "=== 运行撮合优先级测试 ==="
node test/a-token-match-priority.test.js 2>&1 | grep -v ExperimentalWarning | grep -v trace-warnings
echo
echo "=== 校验改动点 ==="
grep -n "MAX_REWARD_CHAIN_DEPTH" src/a-token-team-service.js
grep -n "始终「小额优先」\|smallFirst =" src/a-token-order-service.js
md5sum src/a-token-order-service.js src/a-token-team-service.js src/server.js test/a-token-match-priority.test.js
