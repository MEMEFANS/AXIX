#!/bin/bash
echo "=== 预检 OPTIONS（模拟浏览器跨域） ==="
curl -s -i -X OPTIONS "https://bsc-rpc.publicnode.com" \
  -H "Origin: https://axix.cc" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type" \
  --max-time 15 | head -25
