grep -oE '^[A-Za-z_][A-Za-z0-9_]*' /var/lib/wg-platform/.env 2>/dev/null | sort
echo "---"
grep -nE 'adminUsername|adminPassword|operatorToken' /opt/wg-platform/src/config.js
