#!/bin/bash
echo '=== activation-service reconcile/autoVerify 核心(300-460行) ==='
sed -n '300,460p' /opt/wg-platform/src/a-token-activation-service.js
echo
echo '=== server.js 里 activation 服务启动调用 ==='
grep -n 'activation\|Activation' /opt/wg-platform/src/server.js | head -15
