#!/bin/bash
cd /opt/wg-platform
echo "=== 语法检查 ==="
for f in src/a-token-order-service.js src/a-token-team-service.js src/server.js test/a-token-match-priority.test.js; do
  node --check "$f" && echo "OK $f"
done
echo
echo "=== 撮合优先级测试 ==="
node test/a-token-match-priority.test.js 2>&1 | grep -v Warning
echo
echo "=== 改动点确认 ==="
grep -n "MAX_REWARD_CHAIN_DEPTH\|LEVEL_DIFF_MAX_DEPTH" src/a-token-team-service.js | head -5
grep -n "isTeamAward && i >= \|!isTeamAward && i >=" src/a-token-team-service.js
grep -n "始终「小额优先」" src/a-token-order-service.js
md5sum src/a-token-order-service.js src/a-token-team-service.js src/server.js test/a-token-match-priority.test.js
