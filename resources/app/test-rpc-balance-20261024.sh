#!/bin/bash
cat > /tmp/rpcreq.json <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x55d398326f99059fF775485246999027B3197955","data":"0x70a08231000000000000000000000000a71e0cfb92643ccf1fadcd45fcfb29b7b39c56e6"},"latest"]}
EOF
curl -s -X POST -H 'content-type: application/json' --data @/tmp/rpcreq.json https://bsc-rpc.publicnode.com
echo
