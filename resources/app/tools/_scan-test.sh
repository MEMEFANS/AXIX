MAIN=0xa71e0cfb92643ccf1fadcd45fcfb29b7b39c56e6

echo "=== test bscscan txlist WITHOUT key ==="
curl -s -m 25 "https://api.bscscan.com/api?module=account&action=txlist&address=$MAIN&startblock=0&endblock=99999999&page=1&offset=5&sort=desc" | head -c 600
echo
echo
echo "=== test bscscan txlist with placeholder key ==="
curl -s -m 25 "https://api.bscscan.com/api?module=account&action=txlist&address=$MAIN&startblock=0&endblock=99999999&page=1&offset=5&sort=desc&apikey=YourApiKeyToken" | head -c 600
echo
echo
echo "=== test etherscan v2 unified (placeholder) ==="
curl -s -m 25 "https://api.etherscan.io/v2/api?chainid=56&module=account&action=txlist&address=$MAIN&page=1&offset=5&sort=desc" | head -c 400
echo
echo "=== done ==="
