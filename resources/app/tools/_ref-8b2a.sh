DB=/opt/wg-platform/wg-platform.sqlite
W=0x8B2a642A6b658532044B08F60fA4E117700b0D79

echo "=== find this wallet's referrer ==="
sqlite3 "$DB" ".tables" | tr ' ' '\n' | grep -iE 'referr|link|relation|invit'

echo
echo "=== any direct_activate flow referencing miner:2:<this wallet> ==="
sqlite3 -header -column "$DB" "SELECT id, wallet, change, type, ref_id, datetime(created_at/1000,'unixepoch','+8 hours') t FROM lottery_flows WHERE ref_id LIKE '%8b2a642a%' ORDER BY created_at DESC LIMIT 10;"

echo
echo "=== scan-related env keys ==="
grep -iE 'SCAN|ETHERSCAN|API_KEY|BSCSCAN' /opt/wg-platform/.env | sed -E 's/=(.{4}).*/=\1***/' || echo "(none)"

echo "=== done ==="
