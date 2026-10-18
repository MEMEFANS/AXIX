echo "=== grep .env for any key-ish names ==="
grep -iE 'KEY|SECRET|TOKEN|SCAN' /opt/wg-platform/.env | sed -E 's/=(.{6}).*/=\1***/'

echo
echo "=== any file under /opt/wg-platform mentioning bscscan/etherscan ==="
grep -rilE 'bscscan|etherscan' /opt/wg-platform/src /opt/wg-platform/*.json /opt/wg-platform/*.mjs 2>/dev/null | head

echo
echo "=== deposits table schema ==="
sqlite3 /opt/wg-platform/wg-platform.sqlite ".schema deposits" 2>/dev/null | head -30 || echo "(no deposits table)"

echo
echo "=== does any table look like a chain-payment log? ==="
sqlite3 /opt/wg-platform/wg-platform.sqlite ".tables" | tr ' ' '\n' | grep -iE 'deposit|recharge|income|inbound|payment|receipt|watch'

echo "=== done ==="
