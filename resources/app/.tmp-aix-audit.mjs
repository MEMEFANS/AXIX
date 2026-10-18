import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('/var/lib/wg-platform/wg-platform.sqlite', { readOnly: true });
const fa = (b) => (Number(b) / 1e18).toFixed(2);
const fu = (b) => (Number(b) / 1e6).toFixed(2);

const cut = Date.now() - 3 * 86400000;
const oCount = db.prepare('SELECT COUNT(*) c FROM a_token_orders').get().c;
const tCount = db.prepare('SELECT COUNT(*) c FROM a_token_trades').get().c;
console.log(`ORDERS_TOTAL=${oCount} TRADES_TOTAL=${tCount}`);
console.log(`NOW=${new Date().toISOString()} CUTOFF=${new Date(cut).toISOString()}`);

const recent = db.prepare('SELECT payload_json, size_units, amount_usdt_units FROM a_token_trades WHERE created_at > ? LIMIT 5000').all(cut);
console.log(`RECENT3D_TRADES=${recent.length}`);
const byOrder = new Map();
for (const r of recent) {
  let p = {}; try { p = JSON.parse(r.payload_json || '{}'); } catch { /* skip */ }
  if (!p.orderId) continue;
  const c = byOrder.get(p.orderId) || { size: 0n, usdt: 0n, n: 0 };
  c.size += BigInt(r.size_units || '0');
  c.usdt += BigInt(r.amount_usdt_units || '0');
  c.n += 1;
  byOrder.set(p.orderId, c);
}
console.log(`TRADED_ORDERS=${byOrder.size}`);

console.log('\n状态      类型    剩余USDT      剩余AIX     累计成交AIX  笔  单号      判读');
for (const o of db.prepare('SELECT * FROM a_token_orders ORDER BY created_at DESC LIMIT 25').all()) {
  const a = byOrder.get(o.id) || { size: 0n, usdt: 0n, n: 0 };
  const initUsdt = BigInt(o.input_usdt_units || '0');
  const initA = BigInt(o.input_a_units || '0');
  const verdict = o.status === 'FILLED'
    ? ((initUsdt !== 0n || initA !== 0n) ? '已成交但剩余未清零(BUG)' : 'OK')
    : (a.n > 0 ? (o.side === 'buy' ? (initUsdt > 0n ? '部分成交,剩余有值' : '部分成交但剩余=0(BUG)')
                               : (initA > 0n ? '部分成交,剩余有值' : '部分成交但剩余=0(BUG)')) : '未成交');
  console.log([
    o.status.padEnd(9), String(o.order_type).padEnd(6),
    fu(initUsdt).padStart(13), fa(initA).padStart(12), fa(a.size).padStart(13),
    String(a.n).padStart(3), o.id.slice(-6), ' ' + verdict,
  ].join(' '));
}
