MAIN=0xa71e0cfb92643ccf1fadcd45fcfb29b7b39c56e6

echo "=== a) bscscan with -L (follow redirect), no key ==="
curl -s -m 25 -L "https://api.bscscan.com/api?module=account&action=txlist&address=$MAIN&page=1&offset=3&sort=desc" | head -c 500
echo
echo
echo "=== b) blockscout bsc v2 REST ==="
curl -s -m 25 "https://bsc.blockscout.com/api/v2/addresses/$MAIN/transactions?filter=to" | head -c 500
echo
echo
echo "=== c) debank history ==="
curl -s -m 25 "https://api.debank.com/history/list?user_addr=$MAIN&chain=bsc&page_count=3" -H 'accept: application/json' | head -c 500
echo
echo
echo "=== d) nodereal public rpc block fetch speed test (3 blocks) ==="
time curl -s -m 25 -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x79a2b48",true]}' https://bsc-rpc.publicnode.com | head -c 200
echo
echo "=== done ==="
