grep -n "adminMinerTodaySummary\|poolService.database\|walletService.database" /opt/wg-platform/src/a-token-admin-api.js | head -n 20
echo "--- md5 compare local-deployed ---"
md5sum /opt/wg-platform/src/a-token-admin-api.js