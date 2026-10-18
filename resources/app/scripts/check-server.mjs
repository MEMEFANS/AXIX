import { openDatabase } from './src/database.js';
const db = openDatabase('.');

console.log('=== team_levels ===');
const levels = db.db.prepare('SELECT wallet, payload_json FROM a_token_team_levels').all();
console.log('count:', levels.length);
for (const row of levels) {
  const d = JSON.parse(row.payload_json);
  console.log(`${row.wallet.slice(0,12)}...  A${d.level || 0}  personal=${d.personalHeldUnits || '0'}  team=${d.teamHeldUnits || '0'}  directValid=${d.directValidCount || 0}`);
}

console.log('\n=== miners ===');
const miners = db.db.prepare('SELECT wallet, payload_json FROM a_token_miners').all();
console.log('count:', miners.length);
for (const m of miners) {
  const d = JSON.parse(m.payload_json);
  const rem = (BigInt(d.totalUnits || '0') - BigInt(d.totalEarnedUnits || '0')).toString();
  console.log(`${m.wallet.slice(0,12)}...  ${d.plan}  ${d.status}  remaining=${rem}`);
}

console.log('\n=== stakes ===');
const stakes = db.db.prepare('SELECT wallet, payload_json FROM a_token_stakes').all();
console.log('count:', stakes.length);
for (const s of stakes) {
  const d = JSON.parse(s.payload_json);
  console.log(`${s.wallet.slice(0,12)}...  ${d.planId}  ${d.status}  principal=${d.principalUnits}`);
}
