#!/bin/bash
W=0x79B8cEe7Fb9724E3Edb1c7E41bb353873Df512E4
echo "=== 前端 staking API 实际返回 ==="
curl -s "http://127.0.0.1:8082/api/a-token/staking?wallet=$W" | head -c 3000
echo
echo
echo "=== profile 里的 balances/stake 摘要 ==="
curl -s "http://127.0.0.1:8082/api/a-token/profile?wallet=$W" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(JSON.stringify({balances:j.balances, stake:j.stake||j.staking||null, stakeMintedUnits:j.pool?.stakeMintedUnits, stakeShare:null},null,1))}catch(e){console.log(d.slice(0,800))}})"
echo
echo "=== pool meta stakeMintedUnits vs STAKE_SHARE ==="
sqlite3 /var/lib/wg-platform/wg-platform.sqlite "SELECT value FROM service_settings WHERE key='a_token_pool_meta';" | head -c 2000
echo
echo
echo "=== 钱包 A 余额台账对账：8 次结算应入账 8*184.8889=1479.11 A ==="
sqlite3 -header /var/lib/wg-platform/wg-platform.sqlite "SELECT printf('%.4f', CAST(amount_units AS REAL)/1e18) AS amt_A, kind, datetime(created_at/1000,'unixepoch','+8 hours') AS ts_bj FROM a_token_ledger WHERE lower(wallet)=lower('$W') ORDER BY created_at DESC LIMIT 40;" 2>/dev/null || sqlite3 -header /var/lib/wg-platform/wg-platform.sqlite ".tables"
