import { openDatabase } from './src/database.js';
import { formatUnits } from 'ethers';

const db = openDatabase('/var/lib/wg-platform');

// 最近 24h 奖励
const now = Date.now();
const dayAgo = now - 86400000;

const stmt = db.db.prepare(`SELECT kind, amount_units FROM a_token_team_rewards WHERE created_at > ?`);
const rows = stmt.all(dayAgo);

const byKind = {};
for (const r of rows) {
  const kind = r.kind || 'unknown';
  if (!byKind[kind]) byKind[kind] = { count: 0, amount: 0n };
  byKind[kind].count += 1;
  byKind[kind].amount += BigInt(r.amount_units || '0');
}

console.log('=== 最近 24h 奖励 ===');
let total = 0n;
for (const [kind, d] of Object.entries(byKind)) {
  total += d.amount;
  console.log(kind + ': count=' + d.count + ', amount=' + formatUnits(d.amount, 18) + ' AIX');
}
console.log('total=' + formatUnits(total, 18) + ' AIX');

// 也查一下总累计
const allStmt = db.db.prepare(`SELECT kind, amount_units FROM a_token_team_rewards`);
const allRows = allStmt.all();
const allByKind = {};
for (const r of allRows) {
  const kind = r.kind || 'unknown';
  if (!allRows[kind]) allRows[kind] = { count: 0, amount: 0n };
  allRows[kind].count += 1;
  allRows[kind].amount += BigInt(r.amount_units || '0');
}
console.log('=== 累计总奖励 ===');
let allTotal = 0n;
for (const [kind, d] of Object.entries(allRows)) {
  allTotal += d.amount;
  console.log(kind + ': count=' + d.count + ', amount=' + formatUnits(d.amount, 18) + ' AIX');
}
console.log('all_total=' + formatUnits(allTotal, 18) + ' AIX');
