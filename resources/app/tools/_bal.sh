DB=/opt/wg-platform/wg-platform.sqlite
MAIN=0xa71e0cfb92643ccf1fadcd45fcfb29b7b39c56e6
ROT=0xf9767c67a7f82f5b488f73b69e73017f635d333c

rpc() { curl -s -m 20 -X POST -H 'Content-Type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" https://bsc-rpc.publicnode.com; }

echo "=== collection address balances (wei) ==="
echo -n "main : "; rpc eth_getBalance "[\"$MAIN\",\"latest\"]"
echo
echo -n "rot  : "; rpc eth_getBalance "[\"$ROT\",\"latest\"]"
echo
echo
echo "=== activation totals by plan/status ==="
sqlite3 -header -column "$DB" "SELECT plan, status, COUNT(*) c FROM a_token_activations GROUP BY plan,status ORDER BY plan,status;"

echo
echo "=== expected inflow from confirmed activations ==="
sqlite3 -header -column "$DB" "SELECT SUM(CASE WHEN plan='1' THEN 2000000000000000 ELSE 50000000000000000 END) AS wei_sum, COUNT(*) c FROM a_token_activations WHERE status IN ('confirmed','pending');"

echo
echo "=== earliest activation ==="
sqlite3 "$DB" "SELECT datetime(MIN(created_at)/1000,'unixepoch','+8 hours') FROM a_token_activations;"

echo "=== done ==="
