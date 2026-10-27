#!/bin/bash
set -e
cd /opt/wg-platform

# 备份
mkdir -p /opt/wg-platform/backups/deposit-1u-20261024
cp src/wallet-service.js /opt/wg-platform/backups/deposit-1u-20261024/wallet-service.js.bak
cp public/js/wallet-funds.js /opt/wg-platform/backups/deposit-1u-20261024/wallet-funds.js.bak
cp public/index.html /opt/wg-platform/backups/deposit-1u-20261024/index.html.bak
cp public/js/i18n-zh-en.js /opt/wg-platform/backups/deposit-1u-20261024/i18n-zh-en.js.bak

echo "BACKUP_OK"
