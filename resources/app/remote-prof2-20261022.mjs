// 带 caller 链的 CPU profile 抓取：top self / top total / keccak 调用链 / 大 total 根链
import { WebSocket } from 'undici';

const DURATION_MS = Number(process.env.PROF_MS || 30000);

const targets = await (await fetch('http://127.0.0.1:9229/json')).json();
const page = targets.find(t => t.webSocketDebuggerUrl);
if (!page) { console.error('no inspector target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.addEventListener('message', (event) => {
  let msg; try { msg = JSON.parse(event.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  }
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 5000 });
await send('Profiler.start');
console.log(`profiling ${DURATION_MS / 1000}s ...`);
await new Promise(r => setTimeout(r, DURATION_MS));
const { profile } = await send('Profiler.stop');

const nodes = new Map(profile.nodes.map(n => [n.id, n]));
const parentOf = new Map();
for (const n of profile.nodes) for (const c of (n.children || [])) parentOf.set(c, n.id);
const selfHits = new Map(profile.nodes.map(n => [n.id, n.hitCount || 0]));
const childOf = new Map(profile.nodes.map(n => [n.id, n.children || []]));
const totalHits = new Map();
function acc(id) {
  if (totalHits.has(id)) return totalHits.get(id);
  let sum = selfHits.get(id) || 0;
  for (const c of childOf.get(id)) sum += acc(c);
  totalHits.set(id, sum);
  return sum;
}
const rootIds = profile.nodes.filter(n => !parentOf.has(n.id)).map(n => n.id);
let grand = 0;
for (const r of rootIds) grand += acc(r);
if (!grand) grand = 1;
const pct = h => (100 * h / grand).toFixed(1) + '%';
const label = n => `${n.callFrame.functionName || '(anon)'} ${(n.callFrame.url || '').split('/').pop()}:${(n.callFrame.lineNumber || 0) + 1}`;
function chainOf(id) {
  const out = [];
  let cur = id;
  let hops = 0;
  while (cur && hops++ < 24) {
    out.push(label(nodes.get(cur)));
    cur = parentOf.get(cur);
  }
  return out.reverse();
}

console.log(`\n=== top 15 self ===`);
const bySelf = [...profile.nodes].sort((a, b) => (selfHits.get(b.id) || 0) - (selfHits.get(a.id) || 0));
for (const n of bySelf.slice(0, 15)) {
  if (!selfHits.get(n.id)) break;
  console.log(`${pct(selfHits.get(n.id))}\t${label(n)}`);
}

console.log(`\n=== top 15 total (inclusive) ===`);
const byTotal = [...profile.nodes].filter(n => (totalHits.get(n.id) || 0) > 0)
  .sort((a, b) => (totalHits.get(b.id) || 0) - (totalHits.get(a.id) || 0));
const seen = new Set();
let shown = 0;
for (const n of byTotal) {
  if (shown >= 15) break;
  const key = label(n);
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`${pct(totalHits.get(n.id))}\t${key}`);
  shown++;
}

console.log(`\n=== keccak / getAddress 调用链（谁在调）===`);
const keccakNodes = profile.nodes.filter(n => /keccak|getChecksumAddress|getAddress/.test(n.callFrame.functionName || '')
  && /ethers|noble/.test(n.callFrame.url || ''));
const keccakAgg = new Map();
for (const n of keccakNodes) {
  const self = selfHits.get(n.id) || 0;
  if (!self) continue;
  // 找最近的非 ethers 上层帧
  let cur = parentOf.get(n.id);
  let caller = '(root)';
  while (cur) {
    const cf = nodes.get(cur).callFrame;
    if (!/ethers|noble/.test(cf.url || '')) { caller = `${cf.functionName || '(anon)'} ${(cf.url || '').split('/').pop()}:${(cf.lineNumber || 0) + 1}`; break; }
    cur = parentOf.get(cur);
  }
  keccakAgg.set(caller, (keccakAgg.get(caller) || 0) + self);
}
for (const [caller, hits] of [...keccakAgg].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`${pct(hits)}\t${caller}`);
}

console.log(`\n=== total>2% 的业务根链（入口路径）===`);
const bizChains = new Map();
for (const n of byTotal) {
  const t = totalHits.get(n.id) || 0;
  if (t / grand < 0.02) continue;
  const cf = n.callFrame;
  if (/ethers|noble|node:internal|\(root\)|:0/.test(cf.url || '') && !/src\//.test(cf.url || '')) continue;
  const key = label(n);
  if (bizChains.has(key)) continue;
  bizChains.set(key, { t, id: n.id });
}
for (const [key, { t, id }] of [...bizChains].sort((a, b) => b[1].t - a[1].t).slice(0, 10)) {
  console.log(`\n[${pct(t)}] ${key}`);
  console.log('   ' + chainOf(id).join('\n   <- '));
}

ws.close();
process.exit(0);
