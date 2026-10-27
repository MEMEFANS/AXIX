if [ -f /tmp/cancel-all.log ]; then
  echo "log exists, progress:"
  echo "  ok=$(grep -c '^OK ' /tmp/cancel-all.log) fail=$(grep -c '^FAIL ' /tmp/cancel-all.log) total=$(wc -l < /tmp/order-ids.txt 2>/dev/null || echo '?')"
  tail -n 3 /tmp/cancel-all.log
  [ -f /tmp/cancel-done.flag ] && echo "DONE_FLAG_PRESENT" || echo "STILL_RUNNING (or dead)"
else
  echo "NO_LOG — loop never started"
fi
