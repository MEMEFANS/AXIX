#!/bin/bash
set -e
cd /opt/wg-platform/public

# 备份
mkdir -p /opt/wg-platform/backups/frontend-10pct-20261024
for f in index.html promo-team.html promo-guide.html promo-invite.html promo-platform.html infographic.html; do
  cp -v "$f" "/opt/wg-platform/backups/frontend-10pct-20261024/$f.bak"
done

echo "BACKUP_OK"
