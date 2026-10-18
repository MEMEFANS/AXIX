import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { openDatabase, closeDatabase } from '../src/database.js';
import { createATokenTeamService } from '../src/a-token-team-service.js';
import { createATokenMinerService } from '../src/a-token-miner-service.js';
import { createATokenApi } from '../src/a-token-api.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axix-team-loading-'));
const A = n => BigInt(n) * 10n ** 18n;
const address = n => '0x' + n.toString(16).padStart(40, '0');
const main = address(1), parent = address(2);
const now = Date.parse('2026-10-10T12:00:00+08:00');
try {
  const db = openDatabase(root);
  const balances = new Map();
  const user = db.db.prepare('INSERT INTO wallet_users(address,balances_json,created_at,updated_at,payload_json) VALUES(?,?,?,?,?)');
  const add = (id, referrer = null) => {
    const wallet = address(id);
    const balance = A(id % 9 ? 1200 : 0);
    balances.set(wallet, balance);
    user.run(wallet, JSON.stringify({ A: balance.toString(), USDT: '0' }), now, now, '{}');
    db.upsertReferralLink({ wallet, referrerWallet: referrer, code: String(id), createdAt: now });
    return wallet;
  };
  db.transaction(() => {
    add(2); add(1, parent);
    const miners = createATokenMinerService({ database: db });
    for (let i = 0; i < 100; i++) {
      const direct = add(100 + i, main);
      if (i % 10 === 0) miners.createMiner(direct, 'mini120', { startedAt: now });
      for (let j = 0; j < 4; j++) {
        const child = add(1000 + i * 4 + j, direct);
        if (j % 2) db.upsertATokenStakeRow({ id: 'stake_' + i + '_' + j, wallet: child,
          planId: 's30', principalUnits: A(3000).toString(), totalEarnedUnits: A(124).toString(),
          dailyRateBps: 80, startedAt: now, expiresAt: now + 30 * 86400000,
          lastSettledAt: now + 86400000, dayEarnedUnits: A(24).toString(), status: 'active' });
      }
    }
    db.upsertATokenTeamStatsOverride({ wallet: main, dDirect: 3, dTeam: 100, dDirectMini: 2 });
    db.upsertATokenTeamStatsOverride({ wallet: address(100), dDirect: 2, dTeam: 50, dTeamPro: 1 });
    for (let i = 0; i < 601; i++) db.insertATokenTeamRewardRow({ id: 'reward_' + i,
      recipientWallet: main, sourceWallet: address(100), kind: i % 2 ? 'parity' : 'miner_team',
      amountUnits: A(1).toString(), createdAt: now + i });
  });
  let referralReads = 0, balanceReads = 0;
  const counted = new Proxy(db, { get(target, property) {
    if (property === 'listReferralLinks') return () => { referralReads++; return db.listReferralLinks(); };
    return target[property];
  } });
  const walletService = { database: counted, balanceUnits(wallet, asset) {
    balanceReads++;
    assert.equal(asset, 'A');
    return balances.get(wallet.toLowerCase()) || 0n;
  } };
  const team = createATokenTeamService({ database: counted, walletService });
  const beforeWallets = JSON.stringify(db.db.prepare('SELECT * FROM wallet_users ORDER BY address').all());
  const beforeRewards = JSON.stringify(db.db.prepare('SELECT * FROM a_token_team_rewards ORDER BY id').all());
  const beforeLevels = JSON.stringify(db.db.prepare('SELECT * FROM a_token_team_levels ORDER BY wallet').all());
  const summaryStart = performance.now();
  const fast = team.summary(main.toUpperCase());
  const summaryMs = performance.now() - summaryStart;
  assert.deepEqual(fast, { directReferrer: parent, directCount: 103, teamCount: 650 });
  assert.equal(balanceReads, 0, 'Counts cannot query balances, stakes or miners');
  assert.equal(referralReads, 1, 'Counts read referral relationships once');
  assert.equal(JSON.stringify(db.db.prepare('SELECT * FROM a_token_team_levels ORDER BY wallet').all()), beforeLevels, 'Summary cannot write economic level snapshots');
  const summaries = { send: (res, status, data) => Object.assign(res, { status, data }), readBody: async () => ({}),
    getSession: request => request.session, walletService, teamService: team };
  const api = createATokenApi(summaries);
  const guest = {};
  await api.handle({ method: 'GET' }, guest, '/api/a-token/team/summary');
  assert.equal(guest.status, 401);
  const response = {};
  await api.handle({ method: 'GET', session: { address: main } }, response, '/api/a-token/team/summary');
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, fast);

  // When the local audit archive exists, also compare every field to the old service.
  const baselineFile = path.resolve(import.meta.dirname, '../../../tools/miner-speed-20261011/before/src/a-token-team-service.js');
  let expected = null, baselineMs = null, baselineScans = null;
  if (fs.existsSync(baselineFile)) {
    let baselineSource = fs.readFileSync(baselineFile, 'utf8');
    baselineSource = baselineSource.replaceAll("'./a-token-ledger.js'", JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../src/a-token-ledger.js')).href));
    baselineSource = baselineSource.replaceAll("'./a-token-income.js'", JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../src/a-token-income.js')).href));
    baselineSource = baselineSource.replaceAll("'ethers'", JSON.stringify(import.meta.resolve('ethers')));
    const baselineModule = await import('data:text/javascript;base64,' + Buffer.from(baselineSource).toString('base64'));
    const baseline = baselineModule.createATokenTeamService({ database: counted, walletService });
    referralReads = 0;
    const baselineStart = performance.now();
    expected = baseline.profile(main);
    baselineMs = performance.now() - baselineStart;
    baselineScans = referralReads;
  }
  referralReads = 0;
  const optimizedStart = performance.now();
  const actual = team.profile(main);
  const optimizedMs = performance.now() - optimizedStart;
  const optimizedScans = referralReads;
  if (expected) assert.deepEqual(actual, expected, 'Optimization must preserve every count, holding, level and full-history reward');
  assert.equal(actual.totalEarnedA, '601.0');
  assert.equal(actual.byKind.miner_team, '301.0');
  assert.equal(actual.byKind.parity, '300.0');
  assert.equal(actual.teamHoldA, '1116700.0');
  assert.equal(actual.directHoldA, '107000.0');
  assert.equal(actual.teamStakeA, '580000.0');
  assert.equal(actual.teamStakeUsers, 200);
  assert.equal(actual.teamMini, 12);
  assert.equal(actual.teamPro, 1);
  assert.equal(actual.level, 1);
  assert.equal(actual.teamCount, fast.teamCount);
  assert.equal(actual.directCount, fast.directCount);
  assert(optimizedScans <= 4, 'Full team queries must eliminate per-direct full-table scans');
  if (baselineScans != null) assert(baselineScans > 100);
  assert.equal(JSON.stringify(db.db.prepare('SELECT * FROM wallet_users ORDER BY address').all()), beforeWallets);
  assert.equal(JSON.stringify(db.db.prepare('SELECT * FROM a_token_team_rewards ORDER BY id').all()), beforeRewards);

  // Cyclic and duplicate relationships must not double-count people or count the wallet itself.
  const cyclic = createATokenTeamService({ database: { ...db, listReferralLinks: () => [
    { wallet: main, referrerWallet: address(100) }, { wallet: address(100), referrerWallet: main },
    { wallet: address(100).toUpperCase(), referrerWallet: main },
  ], listATokenTeamStatsOverrides: () => [] }, walletService });
  assert.equal(cyclic.summary(main).teamCount, 1);
  assert.equal(cyclic.summary(main).directCount, 1);
  const result = { wallets: balances.size, summary_ms: Number(summaryMs.toFixed(2)), baseline_full_ms: baselineMs == null ? null : Number(baselineMs.toFixed(2)),
    optimized_full_ms: Number(optimizedMs.toFixed(2)), baseline_referral_scans: baselineScans,
    optimized_referral_scans: optimizedScans, complete_profile_unchanged: true, full_history_601_rewards: true,
    balances_unchanged: true, reward_rows_unchanged: true };
  const evidence = path.resolve(import.meta.dirname, '../../../tools/miner-speed-20261011');
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'service-test-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  closeDatabase(root);
  assert(fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
}
