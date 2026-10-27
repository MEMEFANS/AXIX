#!/bin/bash
cd /opt/wg-platform
echo "=== 撮合优先级测试（全场景）==="
node test/a-token-match-priority.test.js 2>&1 | grep -v Warning
echo "exit=$?"
