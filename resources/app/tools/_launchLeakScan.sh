cd /opt/wg-platform
setsid nohup node scripts/leakscan.mjs "${1:-24}" > /tmp/leakscan.log 2>&1 < /dev/null &
sleep 2
echo STARTED
tail -n 5 /tmp/leakscan.log
