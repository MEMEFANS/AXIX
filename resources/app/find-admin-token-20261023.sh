echo "=== systemd unit env ==="
systemctl cat wg-platform | grep -iE "EnvironmentFile|Environment"
echo ""
echo "=== /opt/wg-platform/.env variable names ==="
grep -oE '^[A-Za-z_][A-Za-z0-9_]*' /opt/wg-platform/.env 2>/dev/null | sort
echo ""
echo "=== drop-ins ==="
ls /etc/systemd/system/wg-platform.service.d/ 2>/dev/null
for f in /etc/systemd/system/wg-platform.service.d/*.conf; do echo "--- $f"; grep -oE '^[A-Za-z_][A-Za-z0-9_]*' "$f" 2>/dev/null; done
