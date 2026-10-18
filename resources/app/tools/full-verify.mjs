// Full verification: live calc vs snapshot for all users
import Database from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1');
process.chdir(__dirname);

const db = new Database.DatabaseSync('./wg-platform.sqlite', { readonly: true });

// Load all data
const wallets = db.prepare("SELECT address as wallet, balances_json FROM wallet_users").all();
const allStakes = db.prepare("SELECT wallet, principal_units, total_earned_units, status FROM a_token_stakes").all();
const allMiners = db.prepare("SELECT wallet, total_units, total_earned_units, status FROM a_token_miners").all();
const links = db.prepare("SELECT wallet, referrer_wallet FROM platform_referral_links").all();
const snapshots = db.prepare("SELECT wallet, level, personal_held_units, team_held_units, updated_at FROM a_token_team_levels").all();

// Build helper maps
const k = (s) => String(s || '').toLowerCase();
const walletBal = new Map();
for (const w of wallets) {
  let bj; try { bj = JSON.parse(w.balances_json || '{}'); } catch { bj = {}; }
  const raw = bj.A || bj.a || '0';
  walletBal.set(k(w.wallet), BigInt(raw));
}

// Build referral tree
const childrenMap = new Map();
for (const l of links) {
  const rw = k(l.referrer_wallet);
  const w = k(l.wallet);
  if (rw) {
    if (!childrenMap.has(rw)) childrenMap.set(rw, []);
    childrenMap.get(rw).push(w);
  }
}

// Get descendants
function getDescendants(wallet) {
  const result = [];
  const visited = new Set();
  const stack = [k(wallet)];
  while (stack.length) {
    const cur = stack.pop();
    for (const child of childrenMap.get(cur) || []) {
      if (!visited.has(child)) { visited.add(child); stack.push(child); result.push(child); }
    }
  }
  return result;
}

// Calc personal for one wallet
function calcPersonal(wallet) {
  const w = k(wallet);
  let total = walletBal.get(w) || 0n;
  for (const s of allStakes) {
    if (k(s.wallet) === w && s.status === 'active') {
      const p = BigInt(s.principal_units || '0');
      const e = BigInt(s.total_earned_units || '0');
      total += p - e;
    }
  }
  for (const m of allMiners) {
    if (k(m.wallet) === w && m.status === 'active') {
      const t = BigInt(m.total_units || '0');
      const e = BigInt(m.total_earned_units || '0');
      const rem = t - e;
      if (rem > 0n) total += rem;
    }
  }
  return total;
}

// Calc team
function calcTeam(wallet) {
  const descs = getDescendants(wallet);
  let total = 0n;
  for (const d of descs) total += calcPersonal(d);
  return total;
}

// Calc level
const TEAM_LEVELS = [
  { level: 1,  personalHeld: 1000,    teamHeld: 5000 },
  { level: 2,  personalHeld: 2000,    teamHeld: 10000 },
  { level: 3,  personalHeld: 4000,    teamHeld: 50000 },
  { level: 4,  personalHeld: 8000,    teamHeld: 100000 },
  { level: 5,  personalHeld: 16000,   teamHeld: 500000 },
  { level: 6,  personalHeld: 32000,   teamHeld: 1000000 },
  { level: 7,  personalHeld: 64000,   teamHeld: 5000000 },
  { level: 8,  personalHeld: 128000,  teamHeld: 10000000 },
  { level: 9,  personalHeld: 256000,  teamHeld: 50000000 },
  { level: 10, personalHeld: 500000,  teamHeld: 100000000 },
];
const A = (n) => BigInt(n) * 10n ** 18n;
function calcLevel(personalUnits, teamUnits) {
  let level = 0;
  for (let i = TEAM_LEVELS.length - 1; i >= 0; i--) {
    const t = TEAM_LEVELS[i];
    if (personalUnits >= A(t.personalHeld) && teamUnits >= A(t.teamHeld)) {
      level = t.level; break;
    }
  }
  return level;
}

console.log('=== Full verification: live calc vs snapshot ===\n');
console.log('Address | SnapLv | SnapP(A) | SnapT(A) | LiveLv | LiveP(A) | LiveT(A) | Diff');
console.log('-'.repeat(120));

for (const snap of snapshots) {
  const w = k(snap.wallet);
  const snapP = BigInt(snap.personal_held_units || '0');
  const snapT = BigInt(snap.team_held_units || '0');
  const snapLvl = Number(snap.level || 0);

  const liveP = calcPersonal(w);
  const liveT = calcTeam(w);
  const liveLvl = calcLevel(liveP, liveT);

  const match = snapP === liveP && snapT === liveT && snapLvl === liveLvl;
  const snapPA = Number(snapP) / 1e18;
  const snapTA = Number(snapT) / 1e18;
  const livePA = Number(liveP) / 1e18;
  const liveTA = Number(liveT) / 1e18;
  const diff = match ? 'OK' : 'MISMATCH!';

  if (!match) {
    console.log(`${snap.wallet.slice(0,14)}... | L${snapLvl} | ${snapPA.toFixed(2)} | ${snapTA.toFixed(2)} | L${liveLvl} | ${livePA.toFixed(2)} | ${liveTA.toFixed(2)} | ${diff}`);
  }
}

// Also check users NOT in snapshot (no referral link)
const allWallets = new Set([...walletBal.keys(), ...links.map(l=>k(l.wallet)), ...links.map(l=>k(l.referrer_wallet)).filter(Boolean)]);
const snapWallets = new Set(snapshots.map(s => k(s.wallet)));
const missing = [...allWallets].filter(w => !snapWallets.has(w));
if (missing.length > 0) {
  console.log(`\n=== ${missing.length} wallets missing from snapshot (may have no referral) ===`);
  for (const w of missing.slice(0, 10)) {
    const p = calcPersonal(w);
    console.log(`  ${w.slice(0,14)}... personal=${Number(p)/1e18}A (${p > 0n ? 'HAS_BALANCE' : 'ZERO'})`);
  }
}

// Summary stats
let matchCount = 0, mismatchCount = 0;
for (const snap of snapshots) {
  const w = k(snap.wallet);
  const snapP = BigInt(snap.personal_held_units || '0');
  const snapT = BigInt(snap.team_held_units || '0');
  const snapLvl = Number(snap.level || 0);
  const liveP = calcPersonal(w);
  const liveT = calcTeam(w);
  const liveLvl = calcLevel(liveP, liveT);
  if (snapP === liveP && snapT === liveT && snapLvl === liveLvl) matchCount++;
  else mismatchCount++;
}
console.log(`\n=== SUMMARY: ${matchCount} matched, ${mismatchCount} mismatched out of ${snapshots.length} snapshots ===`);
