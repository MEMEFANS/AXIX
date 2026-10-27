#!/bin/bash
set -e
cd /var/lib/wg-platform
cp .env .env.bak-deposit-addr-20261024
sed -i 's|^PLATFORM_DEPOSIT_ADDRESS=.*|PLATFORM_DEPOSIT_ADDRESS=0x310A3f1FC3586FDA111743B8D086dFcb941dE954|' .env
echo "=== 改后配置 ==="
grep -n 'PLATFORM_DEPOSIT_ADDRESS' .env
echo
systemctl restart wg-platform.service
echo "restarted at $(date '+%F %T')"
ok=0
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8082/api/a-token/plans 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then echo "ready after ${i}x5s"; ok=1; break; fi
  sleep 5
done
[ "$ok" = "1" ] || { echo "NOT READY"; tail -20 /opt/wg-platform/logs/server.stderr.log; exit 1; }
echo
echo "=== /api/wallet/config 返回的充值地址 ==="
curl -s http://127.0.0.1:8082/api/wallet/config | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(JSON.stringify({depositAddress:j.depositAddress,depositEnabled:j.depositEnabled},null,1))})"
systemctl is-active wg-platform.service
