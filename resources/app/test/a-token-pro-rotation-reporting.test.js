import assert from 'node:assert/strict';
import { createATokenTeamService } from '../src/a-token-team-service.js';
import { createATokenAdminApi } from '../src/a-token-admin-api.js';

const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const tx = n => `0x${n.toString(16).padStart(64, '0')}`;
const [top, nested, historical, actualNew, actualOld, expectedRotationPaidMain, dual, aixOnly, pending, expectedOnly, miniOnly, outsider, outsidePaid] =
  Array.from({ length: 13 }, (_, i) => address(i + 1));
const newRotation = '0x1266d38865460cf7d0c06985ac5587a5e85de2c0';
const oldRotation = '0x0c89b9ddc29f3e4ac968a3e02611bd95a2df1361';
const mainCollection = address(99);
const members = [historical, actualNew, actualOld, expectedRotationPaidMain, dual, aixOnly, pending, expectedOnly, miniOnly];
const links = [
  [top, null], [nested, top], ...members.map(wallet => [wallet, nested]),
  [outsider, null], [outsidePaid, outsider],
].map(([wallet, referrerWallet]) => ({ wallet, referrerWallet }));
const miners = [
  [historical, 'pro1500'], [actualNew, 'pro1500'], [actualOld, 'pro1500', 'completed'],
  [expectedRotationPaidMain, 'pro1500'], [dual, 'pro1500'], [dual, 'mini120'],
  [aixOnly, 'pro1500', 'active', 'ata_aix_only'], [pending, 'pro1500'],
  [expectedOnly, 'pro1500'], [miniOnly, 'mini120'], [outsidePaid, 'pro1500'],
].map(([wallet, plan, status = 'active', activationId], i) => ({
  id: `miner_${i}`, wallet, plan, status, activationId, startedAt: i,
  totalUnits: '1500000000000000000000', totalEarnedUnits: '0',
}));
const activation = (wallet, hash, payload, extra = {}) => ({
  id: `activation_${hash}`, wallet, txHash: tx(hash), plan: '2', status: 'confirmed',
  paymentAsset: 'BNB', payload, ...extra,
});
const activations = [
  // The historical hash was audited before verifiedCollectionAddress existed.
  activation(historical, 1, { collectionAddress: mainCollection }),
  // The expected address can differ from the actual transaction recipient.
  activation(actualNew, 2, { collectionAddress: mainCollection, verifiedCollectionAddress: newRotation.toUpperCase() }),
  activation(actualOld, 3, { collectionAddress: newRotation, verifiedCollectionAddress: oldRotation }),
  activation(expectedRotationPaidMain, 4, { collectionAddress: newRotation, verifiedCollectionAddress: mainCollection }),
  activation(dual, 5, { collectionAddress: oldRotation, verifiedCollectionAddress: newRotation }),
  activation(aixOnly, 6, { collectionAddress: newRotation, verifiedCollectionAddress: newRotation, paymentAsset: 'AIX' }, { paymentAsset: 'AIX' }),
  activation(pending, 7, { collectionAddress: newRotation, verifiedCollectionAddress: newRotation }, { status: 'pending' }),
  activation(expectedOnly, 8, { collectionAddress: newRotation }),
  activation(miniOnly, 9, { collectionAddress: newRotation, verifiedCollectionAddress: newRotation }, { plan: '1' }),
  activation(outsidePaid, 10, { collectionAddress: newRotation, verifiedCollectionAddress: newRotation }),
  // An old activation row alone cannot exclude the wallet's only current AIX miner.
  activation(aixOnly, 11, { collectionAddress: newRotation, verifiedCollectionAddress: newRotation }),
];
let level = { level: 0 };
const collectionQueries = [];
const db = {
  db: { prepare: () => ({ all: () => [] }) },
  listReferralLinks: () => links,
  listATokenMinerWalletsByPlan: plan => new Set(miners.filter(m => m.plan === plan).map(m => m.wallet)),
  listATokenMinerWallets: () => new Set(miners.map(m => m.wallet)),
  listATokenMiners: wallet => miners.filter(m => m.wallet === wallet),
  countATokenMinersByWallet: wallet => miners.filter(m => m.wallet === wallet).length,
  listATokenStakes: () => [], listActiveATokenStakes: () => [],
  getATokenActivationByTx: hash => activations.find(a => a.txHash === hash),
  listConfirmedATokenActivationsByCollection: collection => {
    collectionQueries.push(collection.toLowerCase());
    // Deliberately include expected-address matches and unconfirmed/non-Pro rows:
    // reporting must independently require a verified recipient, plan and status.
    return activations.filter(a => [a.payload.collectionAddress, a.payload.verifiedCollectionAddress]
      .some(value => value?.toLowerCase() === collection.toLowerCase()));
  },
  listATokenTeamStatsOverrides: () => [], getATokenTeamLevel: () => level,
  upsertATokenTeamLevelRow: row => { level = row; },
  getA10Pool: () => null, listATokenTeamLevelsByLevel: () => [],
  adminMinerSummary: () => {
    const groups = new Map();
    for (const m of miners) {
      const key = `${m.status}:${m.plan}`;
      const row = groups.get(key) || { plan: m.plan, status: m.status, c: 0 };
      row.c += 1; groups.set(key, row);
    }
    const rows = [...groups.values()];
    return { total: miners.length, rows, by: Object.fromEntries(rows.map(row => [`${row.status}:${row.plan}`, row.c])) };
  },
};
const walletService = { balanceUnits: () => 0n };
const reportingExclusions = {
  viewers: [top, nested],
  transactionHashes: [tx(1), tx(2), tx(2)],
  collectionAddresses: [newRotation, oldRotation],
};
const team = createATokenTeamService({ database: db, walletService, reportingExclusions });
const recordsBefore = JSON.stringify({ links, miners, activations });

for (const viewer of [top, nested]) {
  const breakdown = team.teamActivationBreakdown(viewer.toUpperCase());
  assert.equal(breakdown.rawTeamPro, 8);
  assert.equal(breakdown.teamPro, 4, 'Historical hashes and verified rotation recipients are combined');
  assert.equal(breakdown.excludedRotationPro, 4, 'Repeated hashes and expected/verified matches do not double count');
  assert.equal(breakdown.teamMini, 2, 'Rotation exclusions apply only to Pro');
  assert.equal(breakdown.directRows.reduce((sum, row) => sum + row.pro, 0), 4);
  const view = team.getTeamStatsView(viewer);
  assert.equal(view.real.teamPro, 8, 'Raw counts remain available separately');
  assert.equal(view.effective.teamPro, 4);
  assert.equal(view.reporting.enabled, true);
  assert.equal(view.reporting.excludedTeamPro, 4);
  assert.equal(view.reporting.excludedDirectPro, viewer === nested ? 4 : 0);
  assert.equal(view.reporting.realTeamPro, 4);
  assert.equal(view.reporting.realDirectPro, viewer === nested ? 4 : 0);
  const profile = team.profile(viewer);
  assert.equal(profile.teamPro, 4);
  assert.equal(profile.directPro, viewer === nested ? 4 : 0);
  assert.equal(profile.teamMini, 2);
  assert.equal(profile.teamMinerUsers, 6, 'A hidden Pro owner with a Mini remains an activated member');
}
assert.deepEqual(new Set(collectionQueries), new Set([newRotation, oldRotation]), 'Both current and historical rotation addresses are queried');
const directs = new Map(team.profile(nested).directs.map(row => [row.wallet, row.minerCount]));
assert.equal(directs.get(historical), 0);
assert.equal(directs.get(actualNew), 0, 'An actual rotation payment is excluded even if a main payment was expected');
assert.equal(directs.get(actualOld), 0, 'The previous verified rotation recipient remains excluded');
assert.equal(directs.get(dual), 1, 'Only Pro is removed from the mixed-plan member');
for (const wallet of [expectedRotationPaidMain, aixOnly, pending, expectedOnly, miniOnly]) {
  assert.equal(directs.get(wallet), 1, 'Expected recipients, AIX activation and incomplete verification cannot hide a miner');
}
assert.equal(team.teamActivationBreakdown(top, [nested]).netPro, 0);
assert.equal(team.profile(outsider).teamPro, 1, 'An unrelated observer keeps their actual team counts');
assert.equal(team.teamActivationBreakdown(outsider).teamPro, 1);
assert.equal(team.getTeamStatsView(outsider).reporting.enabled, false);

const summary = team.reportingMinerSummary();
assert.equal(summary.excludedPro, 4, 'Nested target teams form a union for the global display summary');
assert.equal(summary.total, 7);
assert.equal(summary.by['active:pro1500'], 5);
assert.equal(summary.by['completed:pro1500'], 0, 'Completed rotation Pro miners are deducted from their own group');
assert.equal(summary.by['active:mini120'], 2);
assert.equal(summary.rawTotal, 11);
assert.equal(summary.rawBy['active:pro1500'], 8);
assert.equal(JSON.stringify({ links, miners, activations }), recordsBefore, 'Reporting preserves referrals, miners and activation records');

const admin = createATokenAdminApi({
  aTokenService: { poolStats: () => ({}), getActivationMeta: () => ({}) },
  poolService: { database: db }, aTokenTeamService: team,
  minerService: { presentAll: () => miners, MINER_PLANS: {} },
  send: (res, status, data) => Object.assign(res, { status, data }),
});
const endpointSummaries = [];
for (const pathname of ['/api/admin/a-token/stats', '/api/admin/a-token/miners']) {
  const res = {};
  await admin.handle({ method: 'GET' }, res, pathname, { url: new URL(`http://test${pathname}`) });
  assert.equal(res.status, 200);
  const result = res.data.summary || res.data.miners;
  assert.equal(result.total, 7);
  assert.equal(result.excludedPro, 4);
  assert.equal(result.by['active:pro1500'], 5);
  endpointSummaries.push(result);
}
assert.deepEqual(endpointSummaries[0], endpointSummaries[1], 'Both admin endpoints use the same filtered summary');
assert.equal(JSON.stringify({ links, miners, activations }), recordsBefore, 'Admin display queries preserve all source records');
assert.equal(createATokenTeamService({ database: db, walletService }).reportingMinerSummary().total, 11);

const dynamicOnly = createATokenTeamService({
  database: db, walletService,
  reportingExclusions: { ...reportingExclusions, transactionHashes: [] },
});
assert.equal(dynamicOnly.teamActivationBreakdown(top).teamPro, 5, 'Rotation rules work without a static transaction list');
assert.equal(dynamicOnly.reportingMinerSummary().excludedPro, 3);

miners.push({ ...miners.find(m => m.wallet === actualNew), id: 'new_aix_pro', startedAt: 1000, activationId: 'ata_aix_new' });
const recordsWithAix = JSON.stringify({ links, miners, activations });
for (const viewer of [top, nested]) {
  assert.equal(team.profile(viewer).teamPro, 5, 'A new AIX Pro on a previously hidden wallet is visible');
  assert.equal(team.teamActivationBreakdown(viewer).teamPro, 5);
  assert.equal(team.getTeamStatsView(viewer).reporting.realTeamPro, 5);
  assert.equal(team.getTeamStatsView(viewer).effective.teamPro, 5);
}
const repeated = team.reportingMinerSummary();
assert.equal(repeated.excludedPro, 4, 'An AIX repeat does not cause additional deductions');
assert.equal(repeated.total, 8);
assert.equal(repeated.by['active:pro1500'], 6);
assert.equal(JSON.stringify({ links, miners, activations }), recordsWithAix, 'Repeat-wallet reporting preserves the newly purchased AIX miner');

const futureWallet = address(14);
links.push({ wallet: futureWallet, referrerWallet: nested });
miners.push({ ...miners.find(m => m.wallet === historical), id: 'future_rotation_pro', wallet: futureWallet, startedAt: 2000 });
activations.push(activation(futureWallet, 12, { collectionAddress: mainCollection, verifiedCollectionAddress: newRotation }));
const recordsWithFuture = JSON.stringify({ links, miners, activations });
const originalNow = Date.now;
const refreshedAt = originalNow() + 31_000;
try {
  Date.now = () => refreshedAt;
  assert.equal(team.profile(top).teamPro, 5, 'A future verified rotation payment is excluded after cache refresh without a restart');
  assert.equal(team.teamActivationBreakdown(nested).excludedRotationPro, 4, 'The AIX repeat remains visible when rotation evidence refreshes');
  const futureSummary = team.reportingMinerSummary();
  assert.equal(futureSummary.excludedPro, 5);
  assert.equal(futureSummary.total, 8);
  assert.equal(futureSummary.by['active:pro1500'], 6);
} finally {
  Date.now = originalNow;
}
assert.equal(JSON.stringify({ links, miners, activations }), recordsWithFuture, 'Refresh excludes future payments without modifying source records');

console.log('PASS Pro rotation reporting: verified recipients, scoped/nested teams, historical union, Mini/AIX preservation, matching admin summaries, untouched records');
