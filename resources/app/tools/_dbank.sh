MAIN=0xa71e0cfb92643ccf1fadcd45fcfb29b7b39c56e6
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

echo "=== debank history/list (with delay) ==="
sleep 3
curl -s -m 30 "https://api.debank.com/history/list?user_addr=$MAIN&chain=bsc&page_count=5" \
  -H "accept: application/json" -H "user-agent: $UA" -H "origin: https://debank.com" -H "referer: https://debank.com/" | head -c 900
echo
echo
echo "=== debank token/tx_list (with delay) ==="
sleep 3
curl -s -m 30 "https://api.debank.com/token/tx_list?user_addr=$MAIN&chain_id=56&page_count=5" \
  -H "accept: application/json" -H "user-agent: $UA" -H "origin: https://debank.com" -H "referer: https://debank.com/" | head -c 900
echo
echo
echo "=== done ==="
