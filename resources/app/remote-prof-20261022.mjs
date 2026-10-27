#!/bin/bash
cat > /opt/wg-platform/remote-prof.mjs <<'EOF'
// 远程连接 node inspector（127.0.0.1:9229），抓 10 秒 JS 级 CPU profile
import { WebSocket } from 'undici';
const targets = await (await fetch('http://127.0.0.1:9229/json')).json();
const page = targets.find(t => t.webSocketDebuggerUrl);
if (!page) { console.error('no inspector target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  }
};
await new Promise(r => ws.onopen = r);
console.log('connected, profiling 10s...');
await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 5000 }); // 5ms
await send('Profiler.start');
await new Promise(r => setTimeout(r, 10000));
const { profile } = await send('Profiler.stop');
ws.close();
// 统计 self time
const nodes = new Map(profile.nodes.map(n => [n.id, n]));
const self = new Map();
const total = profile.samples.length;
for (const id of profile.samples) self.set(id, (self.get(id) || 0) + 1);
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log('samples:', total);
for (const [id, cnt] of top) {
  const cf = (nodes.get(id) || {}).callFrame || {};
  const url = String(cf.url || '').replace('file:///opt/wg-platform', '');
  console.log((cnt / total * 100).toFixed(1) + '%\t' + (cf.functionName || '(anon)') + '\t' + url + ':' + (cf.lineNumber + 1));
}
process.exit(0);
EOF
cd /opt/wg-platform && node remote-prof.mjs
