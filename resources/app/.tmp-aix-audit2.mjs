import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('/var/lib/wg-platform/wg-platform.sqlite', { readOnly: true });
const src = db.prepare(`SELECT COALESCE(json_extract(payload_json,'$.source'),'(no-source)') s, COUNT(*) c
  FROM a_token_trades GROUP BY s ORDER BY c DESC`).all();
console.log('=== 成交流水来源分布（全表） ===');
for (const r of src) console.log(`  ${r.s.padEnd(20)} ${r.c}`);

console.log('\n=== 最近 5 笔成交流水的 payload ===');
for (const r of db.prepare('SELECT id, side, size_units, amount_usdt_units, created_at, payload_json FROM a_token_trades ORDER BY created_at DESC LIMIT 5').all()) {
  console.log(`  ${r.id.slice(-6)} ${r.side} size=${r.size_units} amt=${r.amount_usdt_units} ${new Date(Number(r.created_at)).toLocaleString('zh-CN', { hour12: false })}`);
  console.log(`     payload=${String(r.payload_json).slice(0, 220)}`);
}

console.log('\n=== 最近 40 张委托：按钱包看是否有部分成交后剩余未减 ===');
const rows = db.prepare('SELECT * FROM a_token_orders ORDER BY created_at DESC LIMIT 40').all();
const ids = rows.map(r => r.id);
const inList = ids.map(() => '?').join(',');
const trs = db.prepare(`SELECT payload_json, size_units, amount_usdt_units FROM a_token_trades WHERE json_extract(payload_json,'$.orderId') IN (${inList})`).all(...ids);
console.log(`  关联成交行数=${trs.length}`);
const agg = new Map();
for (const r of trs) {
  let p = {}; try { p = JSON.parse(r.payload_json || '{}'); } catch { /* skip */ }
  const c = agg.get(p.orderId) || { a: 0n, u: 0n, n: 0 };
  c.a += BigInt(r.size_units || '0'); c.u += BigInt(r.amount_usdt_units || '0'); c.n += 1;
  agg.set(p.orderId, c);
}
for (const o of rows) {
  const a = agg.get(o.id);
  if (!a) continue;
  console.log(`  ${o.id.slice(-6)} ${o.side} ${o.order_type} ${o.status} 剩余:USDT=${o.input_usdt_units} AIX=${o.input_a_units} | 累计成交 AIX=${(Number(a.a) / 1e18).toFixed(4)} 笔=${a.n}`);
}
