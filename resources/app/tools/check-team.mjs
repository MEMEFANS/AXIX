// Quick DB checker for team performance verification
import Database from 'node:sqlite';
const db = new Database.DatabaseSync('./wg-platform.sqlite', { readonly: true });

const fmt = (v) => (BigInt(v || 0) / 10n**16n).toString().replace(/\.\d+$/, m => m.slice(0,3));

console.log('=== a_token_team_levels (top 20 by team_held) ===');
const rows = db.prepare('SELECT wallet, level, personal_held_units, team_held_units, direct_valid_count FROM a_token_team_levels ORDER BY team_held_units DESC LIMIT 20').all();
for (const r of rows) {
  const pA = (BigInt(r.personal_held_units||0) / 10n**16n).toString();
  const tA = (BigInt(r.team_held_units||0) / 10n**16n).toString();
  console.log(`${r.wallet} | L${r.level} | personal=${pA}A | team=${tA}A | directValid=${r.direct_valid_count}`);
}

console.log('\n=== All referral links ===');
const links = db.prepare('SELECT wallet, referrerWallet FROM platform_referral_links').all();
for (const l of links) console.log(`  ${l.wallet} <- ${l.referrerWallet}`);

console.log('\n=== Wallet A balances ===');
const bals = db.prepare("SELECT wallet, balance FROM wallet_balances WHERE symbol='A' ORDER BY CAST(balance AS REAL) DESC").all();
for (const b of bals) {
  const balA = (BigInt(b.balance||0) / 10n**16n).toString();
  console.log(`  ${b.wallet}: ${balA} A`);
}

console.log('\n=== Active stakes ===');
const stakes = db.prepare("SELECT wallet, principal_units, total_earned_units, status FROM a_token_stakes WHERE status='active'").all();
for (const s of stakes) {
  const pA = (BigInt(s.principal_units||0) / 10n**16n).toString();
  console.log(`  ${s.wallet}: principal=${pA}A, earned=${s.total_earned_units}, status=${s.status}`);
}

console.log('\n=== Active miners ===');
const miners = db.prepare("SELECT wallet, total_units, total_earned_units, status FROM a_token_miners WHERE status='active'").all();
for (const m of miners) {
  const totA = (BigInt(m.total_units||0) / 10n**16n).toString();
  const remA = ((BigInt(m.total_units||0) - BigInt(m.total_earned_units||0)) / 10n**16n).toString();
  console.log(`  ${m.wallet}: total=${totA}A, remaining=${remA}A, status=${m.status}`);
}
