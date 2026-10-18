// Load actual platform services and verify live vs snapshot
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(__dirname);

import { getConfig, ROOT, DATA_ROOT } from './src/config.js';
import { createWalletService } from './src/wallet-service.js';
import { createATokenTeamService } from './src/a-token-team-service.js';
import { splitStakePayment } from './src/a-token-income.js';

const cfg = getConfig();
const walletService = createWalletService({ ...cfg.wallet, dataRoot: DATA_ROOT });
const db = walletService.database;
const teamService = createATokenTeamService({ database: db, walletService });

const k = (s) => String(s || '').toLowerCase();

// Fresh snapshot
console.log('=== Running fresh snapshotAll() ===');
const r = teamService.snapshotAll();
console.log('Snapshotted', r.count, 'users');

// Manual recalc of personal + team (same logic as team service uses)
function getPersonal(w) {
  let total = walletService.balanceUnits(w, 'A');
  for (const s of db.listATokenStakes(w)) {
    if (s.status === 'active') total += splitStakePayment(s, s.totalEarnedUnits).outstanding;
  }
  for (const m of db.listATokenMiners(w)) {
    if (m.status === 'active') {
      const rem = BigInt(m.totalUnits || '0') - BigInt(m.totalEarnedUnits || '0');
      if (rem > 0n) total += rem;
    }
  }
  return total;
}

// Team held calculation (replicate teamHeldOf logic)
function getTeamHeld(wallet) {
  const links = db.listReferralLinks();
  const childrenMap = new Map();
  for (const item of links) {
    const key = k(item.referrerWallet);
    if (!key) continue;
    if (!childrenMap.has(key)) childrenMap.set(key, []);
    childrenMap.get(key).push(k(item.wallet));
  }
  const stakedCache = new Map();
  const walletCache = new Map();
  const teamCache = new Map();
  const visiting = new Set();
  function teamHeldOf(addr) {
    const key = k(addr);
    if (teamCache.has(key)) return teamCache.get(key);
    if (visiting.has(key)) return 0n;
    visiting.add(key);
    let total = 0n;
    for (const child of childrenMap.get(key) || []) {
      const ck = k(child);
      if (!stakedCache.has(ck)) {
        let sp = 0n;
        for (const s of db.listATokenStakes(child)) {
          if (s.status === 'active') sp += splitStakePayment(s, s.totalEarnedUnits).outstanding;
        }
        for (const m of db.listATokenMiners(child)) {
          if (m.status === 'active') {
            const rem = BigInt(m.totalUnits || '0') - BigInt(m.totalEarnedUnits || '0');
            if (rem > 0n) sp += rem;
          }
        }
        stakedCache.set(ck, sp);
      }
      if (!walletCache.has(ck)) {
        try { walletCache.set(ck, walletService.balanceUnits(child, 'A')); }
        catch { walletCache.set(ck, 0n); }
      }
      total += walletCache.get(ck);
      total += stakedCache.get(ck);
      total += teamHeldOf(child);
    }
    visiting.delete(key);
    teamCache.set(key, total);
    return total;
  }
  return teamHeldOf(wallet);
}

const snapshots = db.db.prepare('SELECT wallet, level, personal_held_units, team_held_units FROM a_token_team_levels').all();

console.log('\n=== After fresh snapshot: verify DB == live recalc ===\n');
let mismatch = 0;
for (const snap of snapshots) {
  const w = k(snap.wallet);
  const snapP = BigInt(snap.personal_held_units || '0');
  const snapT = BigInt(snap.team_held_units || '0');
  const snapLv = Number(snap.level || 0);
  
  const liveP = getPersonal(w);
  const liveTeam = getTeamHeld(w);
  const liveLevel = teamService.calcLevel(liveP, liveTeam);
  
  const match = snapP === liveP && snapT === liveTeam && snapLv === liveLevel;
  
  if (!match) {
    mismatch++;
    console.log(`MISMATCH: ${w}`);
    console.log(`  Snapshot: L${snapLv}  P=${(Number(snapP)/1e18).toFixed(4)}  T=${(Number(snapT)/1e18).toFixed(4)}`);
    console.log(`  Live calc: L${liveLevel}  P=${(Number(liveP)/1e18).toFixed(4)}  T=${(Number(liveTeam)/1e18).toFixed(4)}`);
  }
}
console.log(`\nResult: ${snapshots.length - mismatch}/${snapshots.length} match, ${mismatch} mismatches`);

// Now show ALL users ordered by team held
console.log('\n\n=== ALL users with holdings (after fresh snapshot) ===\n');
const links = db.listReferralLinks();
const allAddrs = new Set();
for (const l of links) { if (l.wallet) allAddrs.add(k(l.wallet)); if (l.referrerWallet) allAddrs.add(k(l.referrerWallet)); }
const walletRows = db.db.prepare("SELECT address, balances_json FROM wallet_users").all();
for (const row of walletRows) {
  let bj; try { bj = JSON.parse(row.balances_json || '{}'); } catch { bj = {}; }
  const raw = BigInt(bj.A || bj.a || '0');
  if (raw > 0n) allAddrs.add(k(row.address));
}

const results = [];
for (const w of allAddrs) {
  const p = getPersonal(w);
  const t = getTeamHeld(w);
  const lv = teamService.calcLevel(p, t);
  if (p > 0n || t > 0n) results.push({ w, p, t, lv });
}
results.sort((a, b) => (b.t - a.t > 0n ? 1 : -1));

console.log('Address          | Lvl | Personal(A) | Team(A)     | WalletBal(A) | StakeOut | MinerRem');
console.log('-'.repeat(105));
for (const r of results) {
  const bal = Number(walletService.balanceUnits(r.w, 'A')) / 1e18;
  // breakdown of personal
  let stakeOut = 0n, minerRem = 0n;
  for (const s of db.listATokenStakes(r.w)) {
    if (s.status === 'active') stakeOut += splitStakePayment(s, s.totalEarnedUnits).outstanding;
  }
  for (const m of db.listATokenMiners(r.w)) {
    if (m.status === 'active') {
      const rem = BigInt(m.totalUnits || '0') - BigInt(m.totalEarnedUnits || '0');
      if (rem > 0n) minerRem += rem;
    }
  }
  console.log(`${r.w.slice(0,14)} |  L${String(r.lv).padStart(1)} | ${(Number(r.p)/1e18).toFixed(2).padStart(11)} | ${(Number(r.t)/1e18).toFixed(2).padStart(11)} | ${bal.toFixed(2).padStart(11)} | ${(Number(stakeOut)/1e18).toFixed(0).padStart(8)} | ${(Number(minerRem)/1e18).toFixed(0)}`);
}

process.exit(0);
