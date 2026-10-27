#!/bin/bash
PID=$(pidof node)
echo "=== node 各线程 CPU ==="
top -H -bn2 -d 3 -p $PID | grep -E 'node|PID' | tail -12
echo "=== 线程名对照 ==="
for t in /proc/$PID/task/*; do
  tid=$(basename $t)
  name=$(cat $t/comm 2>/dev/null)
  utime=$(awk '{print $14}' $t/stat 2>/dev/null)
  echo "tid=$tid comm=$name utime_ticks=$utime"
done | sort -t= -k4 -rn | head -10
