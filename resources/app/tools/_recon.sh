echo "=== /opt/wg-platform listing ==="
ls -la /opt/wg-platform | head -40
echo
echo "=== tools dir? ==="
ls -la /opt/wg-platform/tools 2>/dev/null | head -30 || echo "(no tools dir)"
echo
echo "=== src? ==="
ls /opt/wg-platform/src 2>/dev/null | head -10 || echo "(no src)"
echo
echo "=== node version ==="
node -v
echo
echo "=== existing fix scripts anywhere ==="
find /opt/wg-platform -maxdepth 3 -name 'fix-missing*' 2>/dev/null | head
echo "=== done ==="
