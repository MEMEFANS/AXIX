// Load actual services and recalculate live vs snapshot
import Database from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
const __dirname = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1');
process.chdir(__dirname);

// Load the platform's database
const dbFile = path.resolve(__dirname, 'wg-platform.sqlite');
console.log('DB file:', dbFile);
console.log('DB file exists:', fs.existsSync(dbFile));

// We can't easily load the ESM services here, so let's read wallet_users balances_json directly
const db = new Database.DatabaseSync(dbFile, { readonly: true });

// 1. Show wallet_users balances_json for key users
console.log('\n=== Key users wallet balances (from wallet_users.balances_json) ===');
const keyAddrs = [
  '0x00a0df80523b740a69bcc7cf551a3b2c7121b9e3',
  '0xeaE853bf152Af2C742b143Ecc3421EEb6A2D8118',
  '0x14599a1ea252a3c0ae174026db1d8829412b4022',
  '0x2d17a5b13202452cc9d35252890617e990f83fda',
  '0x1e76dd0a5d00d20b4e367ba7c16000c1f529d59d',
  '0xd40d95b1974ca2a2de35d8b6779f1ffc3e56bb1b',
];

// Check the actual column name in wallet_users
const cols = db.prepare("PRAGMA table_info(wallet_users)").all();
console.log('wallet_users columns:', cols.map(c=>c.name).join(', '));

// Try both 'address' and 'wallet' column names
const colName = cols.some(c=>c.name==='address') ? 'address' : 'wallet';
console.log('Using column:', colName);

const wallets = db.prepare(`SELECT ${colName} as wallet, balances_json FROM wallet_users`).all();
for (const w of wallets) {
  const addr = String(w.wallet || '').toLowerCase();
  if (keyAddrs.includes(addr)) {
    let balJson;
    try { balJson = JSON.parse(w.balances_json || '{}'); } catch { balJson = {}; }
    const aixRaw = balJson.A || balJson.a || '0';
    const aixNum = Number(aixRaw || '0');
    console.log(`  ${addr.slice(0,10)}... AIX=${aixRaw} (${aixNum/1e18} AIX)`);
  }
}

// 2. Also check stakes and miners
console.log('\n=== Active stakes by wallet ===');
const stakes = db.prepare("SELECT wallet, principal_units, total_earned_units, status FROM a_token_stakes WHERE status='active'").all();
for (const s of stakes) {
  const pA = Number(s.principal_units || 0) / 1e18;
  console.log(`  ${s.wallet.slice(0,10)}... principal=${pA}A earned=${Number(s.total_earned_units||0)/1e18}A`);
}

console.log('\n=== Active miners by wallet ===');
const miners = db.prepare("SELECT wallet, total_units, total_earned_units, status FROM a_token_miners WHERE status='active'").all();
for (const m of miners) {
  const totA = Number(m.total_units || 0) / 1e18;
  const remA = (Number(m.total_units || 0) - Number(m.total_earned_units || 0)) / 1e18;
  console.log(`  ${m.wallet.slice(0,10)}... total=${totA}A remaining=${remA}A`);
}

// 3. Verify referral chain for the key users
console.log('\n=== Referral tree (all links) ===');
const links = db.prepare("SELECT wallet, referrer_wallet FROM platform_referral_links").all();
const childrenMap = new Map();
for (const l of links) {
  const rw = String(l.referrer_wallet || '').toLowerCase();
  const w = String(l.wallet || '').toLowerCase();
  if (rw) {
    if (!childrenMap.has(rw)) childrenMap.set(rw, []);
    childrenMap.get(rw).push(w);
  }
}
function printTree(wallet, depth=0, visited=new Set()) {
  if (visited.has(wallet)) return;
  visited.add(wallet);
  const prefix = '  '.repeat(depth);
  console.log(`${prefix}${wallet.slice(0,10)}...`);
  for (const child of childrenMap.get(wallet) || []) {
    printTree(child, depth+1, visited);
  }
}
console.log('Full referral tree:');
for (const [parent, kids] of childrenMap) {
  // Only print from root nodes (no parent)
}
// Print all trees
const allNodes = new Set([...childrenMap.keys(), ...links.map(l=>String(l.wallet).toLowerCase())]);
const hasParent = new Set(links.map(l=>String(l.referrer_wallet).toLowerCase()).filter(Boolean));
const roots = [...allNodes].filter(n => !hasParent.has(n));
for (const root of roots) printTree(root);

// 4. Quick verification: live calculation for a user
console.log('\n=== Live recalc for 0x1459...b4022 ===');
const target = '0x14599a1ea252a3c0ae174026db1d8829412b4022';
let livePersonal = 0n;
const targetUser = wallets.find(w => String(w.wallet).toLowerCase() === target);
if (targetUser) {
  let balJson; try { balJson = JSON.parse(targetUser.balances_json || '{}'); } catch { balJson = {}; }
  const aixRaw = balJson.A || balJson.a || '0';
  livePersonal += BigInt(aixRaw);
}
for (const s of stakes) {
  if (String(s.wallet).toLowerCase() === target) {
    livePersonal += BigInt(s.principal_units || '0') - BigInt(s.total_earned_units || '0');
  }
}
for (const m of miners) {
  if (String(m.wallet).toLowerCase() === target) {
    livePersonal += BigInt(m.total_units || '0') - BigInt(m.total_earned_units || '0');
  }
}
console.log(`  Live personal = ${Number(livePersonal) / 1e18} AIX`);

// Team calculation: sum all descendants
function getDescendants(wallet) {
  const result = [];
  const visited = new Set();
  const stack = [wallet];
  while (stack.length) {
    const cur = stack.pop();
    for (const child of childrenMap.get(cur) || []) {
      if (!visited.has(child)) { visited.add(child); stack.push(child); result.push(child); }
    }
  }
  return result;
}
const descs = getDescendants(target);
console.log(`  Descendants (${descs.length}): ${descs.map(d=>d.slice(0,10)).join(', ')}`);

let liveTeam = 0n;
for (const d of descs) {
  // Wallet balance
  const u = wallets.find(w => String(w.wallet).toLowerCase() === d);
  if (u) {
    let bj; try { bj = JSON.parse(u.balances_json || '{}'); } catch { bj = {}; }
    liveTeam += BigInt(bj.A || bj.a || '0');
  }
  // Stakes
  for (const s of stakes) {
    if (String(s.wallet).toLowerCase() === d) {
      liveTeam += BigInt(s.principal_units || '0') - BigInt(s.total_earned_units || '0');
    }
  }
  // Miners
  for (const m of miners) {
    if (String(m.wallet).toLowerCase() === d) {
      liveTeam += BigInt(m.total_units || '0') - BigInt(m.total_earned_units || '0');
    }
  }
}
console.log(`  Live team = ${Number(liveTeam) / 1e18} AIX`);

// Compare with snapshot
const snap = db.prepare("SELECT personal_held_units, team_held_units, level FROM a_token_team_levels WHERE wallet=?").get(target);
if (snap) {
  const snapP = Number(snap.personal_held_units) / 1e18;
  const snapT = Number(snap.team_held_units) / 1e18;
  console.log(`  Snapshot personal = ${snapP} AIX`);
  console.log(`  Snapshot team = ${snapT} AIX`);
  console.log(`  Snapshot level = ${snap.level}`);
  console.log(`  DIFF: personal=${Number(livePersonal)/1e18 - snapP} AIX, team=${Number(liveTeam)/1e18 - snapT} AIX`);
}
