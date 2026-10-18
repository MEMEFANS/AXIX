// Verify calcLevel on production server
import Database from 'node:sqlite';
import path from 'node:path';
const db = new Database.DatabaseSync('./wg-platform.sqlite', { readonly: true });

// Check what tables hold wallet balances
console.log('=== Looking for balance tables ===');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t=>t.name).join(', '));

// Check wallet_users structure
console.log('\n=== wallet_users columns ===');
try {
  const cols = db.prepare("PRAGMA table_info(wallet_users)").all();
  console.log(cols.map(c=>c.name).join(', '));
  // Sample some rows with AIX balance
  const users = db.prepare("SELECT wallet, level FROM wallet_users LIMIT 5").all();
  for (const u of users) console.log(JSON.stringify(u));
} catch(e) { console.log('Error:', e.message); }

// Now run actual team service calcLevel
console.log('\n=== Loading team service and recalculating ===');

// We need the actual service. Let me just load it directly.
process.chdir(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1'));

// Simple calcLevel inline to verify
const TEAM_LEVELS = [
  { level: 1,  personalHeld: 1000,    teamHeld: 5000,        rateBps: 1000 },
  { level: 2,  personalHeld: 2000,    teamHeld: 10000,       rateBps: 2000 },
  { level: 3,  personalHeld: 4000,    teamHeld: 50000,       rateBps: 3000 },
  { level: 4,  personalHeld: 8000,    teamHeld: 100000,      rateBps: 4000 },
  { level: 5,  personalHeld: 16000,   teamHeld: 500000,      rateBps: 5000 },
  { level: 6,  personalHeld: 32000,   teamHeld: 1000000,     rateBps: 6000 },
  { level: 7,  personalHeld: 64000,   teamHeld: 5000000,     rateBps: 7000 },
  { level: 8,  personalHeld: 128000,  teamHeld: 10000000,    rateBps: 8000 },
  { level: 9,  personalHeld: 256000,  teamHeld: 50000000,    rateBps: 9000 },
  { level: 10, personalHeld: 500000,  teamHeld: 100000000,   rateBps: 10000 },
];
const A = (n) => BigInt(n) * 10n ** 18n;

function calcLevel(personalUnits, teamUnits) {
  let level = 0;
  for (let i = TEAM_LEVELS.length - 1; i >= 0; i--) {
    const t = TEAM_LEVELS[i];
    if (personalUnits >= A(t.personalHeld) && teamUnits >= A(t.teamHeld)) {
      level = t.level;
      break;
    }
  }
  return level;
}

// Test the problematic cases
const testCases = [
  ['0x00A0Df80523b740A69BCc7cf551A3b2c7121B9E3', '10595116', '344277'],
  ['0xEaE853bf152Af2C742b143Ecc3421EEb6A2D8118', '2205', '875507'],
  ['0xaC308f10939507EdE8A7dB722955a88D12D7e430', '3307', '872200'],
  ['0x14599A1ea252a3C0ae174026db1D8829412b4022', '1000500', '7000000'],
  ['0x2d17a5B13202452CC9D35252890617E990f83FDa', '1000000', '6000000'],
  ['0x436252B4759Eee30066A0d1101911CAa7a63ccf2', '23095', '40000'],
  ['0x1E76Dd0a5D00D20b4e367Ba7c16000c1f529D59d', '1100', '18939893'],
];

console.log('\n=== Manual calcLevel check ===');
for (const [addr, pA, tA] of testCases) {
  // Convert human-readable AIX back to raw 18-decimal units
  const personal = BigInt(pA) * 10n ** 18n;
  const team = BigInt(tA) * 10n ** 18n;
  const lvl = calcLevel(personal, team);
  console.log(`${addr.slice(0,10)}... | personal=${pA}A, team=${tA}A → calcLevel=${lvl}`);
}

// Also check raw DB values directly
console.log('\n=== Raw DB values vs calcLevel ===');
const rows = db.prepare('SELECT wallet, level, personal_held_units, team_held_units FROM a_token_team_levels').all();
for (const r of rows) {
  const p = BigInt(r.personal_held_units || '0');
  const t = BigInt(r.team_held_units || '0');
  const calc = calcLevel(p, t);
  if (calc !== r.level) {
    console.log(`  MISMATCH: ${r.wallet.slice(0,10)}... DB level=${r.level} but calcLevel=${calc}`);
    console.log(`    personal_held_units=${p.toString().slice(0,20)}... (${(p/10n**18n).toString()}A)`);
    console.log(`    team_held_units=${t.toString().slice(0,20)}... (${(t/10n**18n).toString()}A)`);
  }
}
console.log('Done checking mismatches.');
