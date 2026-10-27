PID=$(pidof node)
kill -USR1 "$PID"
sleep 3
cd /opt/wg-platform && node remote-prof.mjs 2>&1 | tail -n 40
