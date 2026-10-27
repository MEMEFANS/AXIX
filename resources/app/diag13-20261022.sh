#!/bin/bash
PID=$(pidof node)
echo "=== 网卡收发速率（10 秒采样） ==="
IF=$(ip route | awk '/default/ {print $5; exit}')
A_RX=$(cat /sys/class/net/$IF/statistics/rx_bytes)
A_TX=$(cat /sys/class/net/$IF/statistics/tx_bytes)
sleep 10
B_RX=$(cat /sys/class/net/$IF/statistics/rx_bytes)
B_TX=$(cat /sys/class/net/$IF/statistics/tx_bytes)
echo "网卡 $IF: 下行 $(( (B_RX-A_RX)/10/1024 )) KB/s, 上行 $(( (B_TX-A_TX)/10/1024 )) KB/s"
echo "=== node 进程 TCP 连接的目标解析 ==="
for ip in $(ss -tnp 2>/dev/null | grep "pid=$PID" | awk '{print $5}' | sed 's/:[0-9]*$//' | sort -u | head -8); do
  host $ip 2>/dev/null | awk '{print "  "$NF}' | head -1
done
echo "=== 行情层对象规模（inspector 查询） ==="
cat > /tmp/inspect-count.js <<'EOF'
const { Session } = require('inspector');
const s = new Session();
s.connect();
s.post('Runtime.enable', () => {
  s.post('Runtime.evaluate', { expression: `
    JSON.stringify({
      sharedPriceStreams: (globalThis.__marketStreamsDebug ? 'no-hook' : 'n/a'),
      nodeVersion: process.version,
      uptimeSec: Math.round(process.uptime()),
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1048576),
      heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1048576)
    })`
  }, (err, result) => {
    if (result && result.result) console.log(result.result.value);
    process.exit(0);
  });
});
EOF
node /tmp/inspect-count.js
