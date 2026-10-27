#!/bin/bash
PID=$(pidof node)
echo "=== 激活 inspector（SIGUSR1，仅监听 127.0.0.1） ==="
kill -USR1 $PID
sleep 1
echo "=== 抓 10 秒 CPU profile（JS 符号级） ==="
cat > /tmp/cpu-prof.js <<'EOF'
const { Session } = require('inspector');
const fs = require('fs');
const s = new Session();
s.connect();
s.post('Profiler.enable', () => {
  s.post('Profiler.start', () => {
    setTimeout(() => {
      s.post('Profiler.stop', (err, { profile }) => {
        fs.writeFileSync('/tmp/cpu-profile.json', JSON.stringify(profile));
        const nodes = new Map(profile.nodes.map(n => [n.id, n]));
        const self = new Map();
        const total = profile.samples.length;
        for (const id of profile.samples) self.set(id, (self.get(id) || 0) + 1);
        const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
        for (const [id, cnt] of top) {
          const cf = (nodes.get(id) || {}).callFrame || {};
          const url = String(cf.url || '').replace('file:///opt/wg-platform', '').replace('node:', 'node:');
          console.log((cnt / total * 100).toFixed(1) + '%\t' + (cf.functionName || '(anonymous)') + '\t' + url + ':' + cf.lineNumber);
        }
        process.exit(0);
      });
    }, 10000);
  });
});
EOF
node /tmp/cpu-prof.js
