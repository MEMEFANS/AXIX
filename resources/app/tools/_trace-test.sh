MAIN=0xa71e0cfb92643ccf1fadcd45fcfb29b7b39c56e6
# block range ~1000 blocks around today (127542907 current)
FROM=0x79a2b00
TO=0x79a2ef0

try() {
  NAME=$1; URL=$2
  echo "--- $NAME ---"
  curl -s -m 20 -X POST -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"trace_filter\",\"params\":[{\"fromBlock\":\"$FROM\",\"toBlock\":\"$TO\",\"toAddress\":[\"$MAIN\"]}]}" \
    "$URL" | head -c 400
  echo
}

try "publicnode"  https://bsc-rpc.publicnode.com
try "dataseed"    https://bsc-dataseed.binance.org
try "1rpc"        https://1rpc.io/bnb
try "ankr"        https://rpc.ankr.com/bsc
try "defibit"     https://bsc-dataseed1.defibit.io
echo "=== done ==="
