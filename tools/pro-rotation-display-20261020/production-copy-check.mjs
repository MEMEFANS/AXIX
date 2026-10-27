import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Run from the isolated deployment-check directory; no production path is accepted.
const root = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(root, 'production-copy-results.json');
const lower = value => String(value || '').toLowerCase();
const digest = value => createHash('sha256').update(value).digest('hex');
const stringify = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { bigint: item.toString() } : item);
const quoteIdentifier = name => `"${name.replaceAll('"', '""')}"`;
const opened = [];
const results = { ok: false, generatedAt: new Date().toISOString(), teams: {}, databaseAudits: {} };

function checkedCopy(name) {
  const directory = path.join(root, name);
  const dataRoot = path.join(directory, 'data');
  const databaseFile = path.join(dataRoot, 'wg-platform.sqlite');
  for (const filename of [directory, dataRoot, databaseFile]) {
    assert.equal(fs.realpathSync(filename), path.resolve(filename), `${name} must use a real local copy, not a symlink: ${filename}`);
  }
  const stat = fs.statSync(databaseFile);
  assert.ok(stat.isFile(), `${name} database copy must exist`);
  assert.equal(stat.nlink, 1, `${name} database copy must not be a hard link`);
  return { name, directory, dataRoot, databaseFile, stat };
}

function fingerprint(connection) {
  const tables = connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const output = {};
  for (const { name } of tables) {
    const statement = connection.prepare(`SELECT * FROM ${quoteIdentifier(name)}`);
    statement.setReadBigInts(true);
    const rowHashes = [];
    for (const row of statement.iterate()) rowHashes.push(digest(stringify(row)));
    rowHashes.sort();
    output[name] = { rows: rowHashes.length, sha256: digest(rowHashes.join('\n')) };
  }
  return output;
}

function fingerprintFile(filename) {
  const connection = new DatabaseSync(filename, { readOnly: true });
  try { return fingerprint(connection); } finally { connection.close(); }
}

async function loadSide(copy) {
  const importSource = name => import(pathToFileURL(path.join(copy.directory, 'src', name)).href);
  const [databaseModule, teamModule, adminModule] = await Promise.all([
    importSource('database.js'), importSource('a-token-team-service.js'), importSource('a-token-admin-api.js'),
  ]);
  const database = databaseModule.openDatabase(copy.dataRoot);
  opened.push({ databaseModule, dataRoot: copy.dataRoot });
  database.db.exec('PRAGMA query_only = ON');
  const config = JSON.parse(fs.readFileSync(path.join(copy.directory, 'pro-reporting-exclusions.json'), 'utf8'));
  const levelSnapshots = new Map();
  // profile() recalculates its level through snapshot(). Retain those calculations
  // in memory so the production-copy check remains read-only, including level rows.
  const readOnlyDatabase = {
    ...database,
    getATokenTeamLevel: wallet => levelSnapshots.get(lower(wallet)) || database.getATokenTeamLevel(wallet),
    upsertATokenTeamLevelRow: row => { levelSnapshots.set(lower(row.wallet), { ...row }); },
  };
  const balanceQuery = database.db.prepare('SELECT balances_json FROM wallet_users WHERE address=? COLLATE NOCASE');
  const walletService = {
    balanceUnits(wallet, asset = 'A') {
      const balances = JSON.parse(balanceQuery.get(wallet)?.balances_json || '{}');
      return BigInt(balances[asset] || '0');
    },
  };
  const team = teamModule.createATokenTeamService({
    database: readOnlyDatabase, walletService, reportingExclusions: config,
    rotationAddresses: (config.collectionAddresses || [config.collectionAddress]).filter(Boolean).join(','),
    rotationHideViewers: config.viewers.join(','),
  });
  return { ...copy, database, config, team, walletService, adminModule };
}

async function checkAdminEndpoints(side) {
  const admin = side.adminModule.createATokenAdminApi({
    aTokenService: { poolStats: () => ({}), getActivationMeta: () => ({}) },
    poolService: { database: side.database }, aTokenTeamService: side.team,
    // Only summary routing is under test; avoid unrelated miner presentation work.
    minerService: { presentAll: () => [], MINER_PLANS: {} },
    send: (response, status, data) => Object.assign(response, { status, data }),
  });
  const summary = side.team.reportingMinerSummary();
  const routes = {};
  for (const pathname of ['/api/admin/a-token/stats', '/api/admin/a-token/miners']) {
    const response = {};
    await admin.handle({ method: 'GET' }, response, pathname, { url: new URL(`http://copy-check.invalid${pathname}`) });
    assert.equal(response.status, 200, `${side.name} ${pathname} must succeed`);
    const routedSummary = response.data.summary || response.data.miners;
    assert.deepEqual(routedSummary, summary, `${side.name} ${pathname} must use the shared reporting summary`);
    routes[pathname] = true;
  }
  return { ...summary, endpointChecks: routes };
}

try {
  const baselineCopy = checkedCopy('baseline');
  const candidateCopy = checkedCopy('candidate');
  assert.notEqual(baselineCopy.databaseFile, candidateCopy.databaseFile);
  assert.ok(baselineCopy.stat.ino !== candidateCopy.stat.ino || baselineCopy.stat.dev !== candidateCopy.stat.dev,
    'Baseline and candidate must use independent database files');
  const before = {
    baseline: fingerprintFile(baselineCopy.databaseFile),
    candidate: fingerprintFile(candidateCopy.databaseFile),
  };
  assert.deepEqual(before.candidate, before.baseline, 'The two database copies must start with identical business rows');
  const baseline = await loadSide(baselineCopy);
  const candidate = await loadSide(candidateCopy);
  const viewers = candidate.config.viewers.map(lower);
  assert.equal(new Set(viewers).size, 2, 'This check must cover both configured viewer addresses');
  assert.deepEqual(new Set(viewers), new Set(baseline.config.viewers.map(lower)), 'Viewer scope must remain unchanged');
  const newHashes = new Set(candidate.config.transactionHashes.map(lower));
  for (const hash of baseline.config.transactionHashes) assert.ok(newHashes.has(lower(hash)), 'Historical audited exclusions must be retained');
  const collections = new Set((candidate.config.collectionAddresses || []).map(lower));
  for (const collection of ['0x1266d38865460cf7d0c06985ac5587a5e85de2c0', '0x0c89b9ddc29f3e4ac968a3e02611bd95a2df1361']) {
    assert.ok(collections.has(collection), `Missing rotation collection address ${collection}`);
  }
  results.configuration = {
    viewers, oldTransactionHashes: baseline.config.transactionHashes.length,
    newTransactionHashes: candidate.config.transactionHashes.length,
    collectionAddresses: [...collections],
  };

  for (const viewer of viewers) {
    const oldProfile = baseline.team.profile(viewer);
    const newProfile = candidate.team.profile(viewer);
    const oldView = baseline.team.getTeamStatsView(viewer);
    const newView = candidate.team.getTeamStatsView(viewer);
    const oldBreakdown = baseline.team.teamActivationBreakdown(viewer);
    const newBreakdown = candidate.team.teamActivationBreakdown(viewer);
    assert.deepEqual(newView.real, oldView.real, `${viewer} raw team statistics must not change`);
    assert.deepEqual(newView.stored, oldView.stored, `${viewer} saved display overrides must not change`);
    const oldExcluded = oldBreakdown.excludedRotationPro || 0;
    const newExcluded = newBreakdown.excludedRotationPro || 0;
    const additionalExcluded = newExcluded - oldExcluded;
    assert.ok(additionalExcluded >= 0, `${viewer} existing audited exclusions must remain applied`);
    assert.equal(newBreakdown.teamPro, newView.real.teamPro - newExcluded, `${viewer} breakdown must subtract verified exclusions`);
    assert.equal(newView.effective.teamPro, oldView.effective.teamPro - additionalExcluded,
      `${viewer} new effective Pro must account for exclusions already applied by baseline`);
    assert.equal(newProfile.teamPro, oldProfile.teamPro - additionalExcluded, `${viewer} profile must apply only the additional exclusions`);
    assert.equal(newProfile.teamPro, newView.effective.teamPro, `${viewer} profile and admin effective Pro must agree`);
    assert.equal(newView.reporting.enabled, true);
    assert.equal(newView.reporting.excludedTeamPro, newExcluded);
    assert.equal(newView.reporting.realTeamPro, newView.real.teamPro - newExcluded, `${viewer} filtered base must equal raw minus hidden`);
    assert.equal(newView.reporting.realTeamPro, newBreakdown.teamPro);
    assert.equal(newView.reporting.realDirectPro, newBreakdown.directPro);
    assert.equal(newView.reporting.realDirectPro, newView.real.directPro - newView.reporting.excludedDirectPro);
    const oldExcludedDirect = oldView.real.directPro - oldBreakdown.directPro;
    const newExcludedDirect = newView.reporting.excludedDirectPro;
    assert.equal(newProfile.directPro, oldProfile.directPro - (newExcludedDirect - oldExcludedDirect));
    assert.equal(newProfile.directPro, newView.effective.directPro);

    for (const field of [
      'teamMini', 'directMini', 'level', 'realLevel', 'levelLabel', 'nextLevel',
      'teamCount', 'directCount', 'indirectCount', 'teamHoldA', 'teamHoldUsers',
      'directHoldA', 'directHoldUsers', 'teamStakeA', 'teamStakeUsers', 'directStakeA', 'directStakeUsers',
      'totalEarnedA', 'byKind', 'a10PoolAccum', 'a10ParticipantCount',
    ]) assert.deepEqual(newProfile[field], oldProfile[field], `${viewer} profile.${field} must not change`);
    for (const field of Object.keys(oldView.effective).filter(field => !['teamPro', 'directPro'].includes(field))) {
      assert.deepEqual(newView.effective[field], oldView.effective[field], `${viewer} effective.${field} must not change`);
    }
    assert.deepEqual(newProfile.directs.map(({ minerCount, ...row }) => row), oldProfile.directs.map(({ minerCount, ...row }) => row),
      `${viewer} direct-member levels, holdings and referral data must not change`);
    results.teams[viewer] = {
      rawPro: newView.real.teamPro, oldDisplayPro: oldProfile.teamPro, newDisplayPro: newProfile.teamPro,
      oldExcludedPro: oldExcluded, excludedPro: newExcluded, additionalExcludedPro: additionalExcluded,
      filteredRealPro: newView.reporting.realTeamPro,
      rawDirectPro: newView.real.directPro, oldDirectPro: oldProfile.directPro, newDirectPro: newProfile.directPro,
      excludedDirectPro: newExcludedDirect, mini: newProfile.teamMini, level: newProfile.level,
      teamHoldA: newProfile.teamHoldA, totalEarnedA: newProfile.totalEarnedA,
      oldMinerUsers: oldProfile.teamMinerUsers, newMinerUsers: newProfile.teamMinerUsers,
    };
  }

  const oldAdmin = await checkAdminEndpoints(baseline);
  const newAdmin = await checkAdminEndpoints(candidate);
  const oldGlobalExcluded = oldAdmin.excludedPro || 0;
  const newGlobalExcluded = newAdmin.excludedPro || 0;
  assert.ok(newGlobalExcluded >= oldGlobalExcluded);
  assert.equal(newAdmin.rawTotal, oldAdmin.rawTotal);
  assert.deepEqual(newAdmin.rawBy, oldAdmin.rawBy);
  assert.equal(newAdmin.total, newAdmin.rawTotal - newGlobalExcluded);
  assert.equal(newAdmin.total, oldAdmin.total - (newGlobalExcluded - oldGlobalExcluded));
  for (const [key, count] of Object.entries(oldAdmin.by)) {
    if (key.endsWith(':mini120')) assert.equal(newAdmin.by[key], count, `${key} must not change`);
  }
  results.admin = { baseline: oldAdmin, candidate: newAdmin, additionalExcludedPro: newGlobalExcluded - oldGlobalExcluded };
  for (const side of [baseline, candidate]) {
    const after = fingerprint(side.database.db);
    assert.deepEqual(after, before[side.name], `${side.name} source records changed during the copy check`);
    results.databaseAudits[side.name] = { unchanged: true, tableCount: Object.keys(after).length, tables: after };
  }
  results.ok = true;
} catch (error) {
  results.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  for (const { databaseModule, dataRoot } of opened.reverse()) {
    try { databaseModule.closeDatabase(dataRoot); } catch (error) {
      results.ok = false; results.closeError = error.message; process.exitCode = 1;
    }
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results));
}
