#!/bin/bash
cd /opt/wg-platform
echo "=== test 目录 ==="
ls -ld test 2>/dev/null || echo "no test dir"
ls test 2>/dev/null | head -20
echo
echo "=== 改动点确认 ==="
grep -n "MAX_REWARD_CHAIN_DEPTH" src/a-token-team-service.js | head -3
grep -n "始终「小额优先」" src/a-token-order-service.js
md5sum src/a-token-order-service.js src/a-token-team-service.js src/server.js
echo
echo "=== 服务状态 ==="
systemctl is-active wg-platform.service
