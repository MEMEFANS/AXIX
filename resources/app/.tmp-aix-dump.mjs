import { DatabaseSync } from 'node:sqlite';

const file = process.argv[2];
const db = new DatabaseSync(file, { readOnly: true });
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
console.log('FILE:', file);
console.log('ORDER_COLS:', cols('a_token_orders').join(', '));
console.log('TRADE_COLS:', cols('a_token_trades').join(', '));

const orders = db.prepare("SELECT * FROM a_token_orders ORDER BY created_at DESC LIMIT 10").all();
console.log('\n=== 最近 10 张 AIX 委托 ===');
for (const o of orders) {
  console.log([o.id.slice(-6), String(o.wallet).slice(0, 10), o.side, o.order_type, o.status,
    'price=' + o.order_price_usdt_units,
    'inUsdt=' + o.input_usdt_units, 'inA=' + o.input_a_units,
    new Date(Number(o.created_at)).toLocaleString('zh-CN', { hour12: false })].join('  '));
}
const t = db.prepare("SELECT * FROM a_token_trades ORDER BY created_at DESC LIMIT 8").all();
console.log('\n=== 最近 8 笔 AIX 成交 ===');
for (const r of t) {
  console.log([r.id.slice(-6), String(r.wallet).slice(0, 10), r.side,
    JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => /unit|price|size|amount/i.test(k)))),
    new Date(Number(r.created_at)).toLocaleString('zh-CN', { hour12: false })].join('  '));
}
console.log('\nOPEN_COUNT =', db.prepare("SELECT COUNT(*) c FROM a_token_orders WHERE status='OPEN'").get().c);
