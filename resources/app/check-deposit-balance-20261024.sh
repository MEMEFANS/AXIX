#!/bin/bash
cd /opt/wg-platform/public
echo "=== 服务器 wallet-funds.js 是否有余额读取函数 ==="
grep -n "refreshDepositWalletBalance\|deposit-wallet-balance" js/wallet-funds.js | head -5
echo
echo "=== 服务器 index.html 是否有余额元素 ==="
grep -n "deposit-wallet-balance" index.html | head -3
echo
echo "=== 服务器 page-loader 版本表 ==="
grep -n "wallet-funds" js/page-loader.js
echo
echo "=== 与本地版本对比 MD5 ==="
md5sum js/wallet-funds.js js/assets.js js/page-loader.js index.html
