#!/bin/bash
set -e
cd /opt/wg-platform
# 在临时目录装 exceljs，避免污染项目依赖
mkdir -p /tmp/xlsxgen
cd /tmp/xlsxgen
if [ ! -d node_modules/exceljs ]; then
  npm init -y >/dev/null 2>&1
  npm install exceljs >/dev/null 2>&1
fi
echo "exceljs ready"
