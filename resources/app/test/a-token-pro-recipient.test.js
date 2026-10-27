import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createATokenActivationService } from '../src/a-token-activation-service.js';
import { openDatabase, closeDatabase } from '../src/database.js';

const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const main = address(900);
const rotation = '0x1266d38865460cf7d0c06985ac5587a5e85de2c0';
const proWei = 5n * 10n ** 16n;
let fixtureNumber = 0;

function fixture({ expectedRotation = false, actualTo = rotation, value = proWei, receiptStatus = 1, confirmations = 20 } = {}) {
  const index = ++fixtureNumber;
  const now = Date.UTC(2026, 9, 20) + index * 1000;
  const wallet = address(index);
  const rows = new Map();
  const settings = new Map();
  const miners = [];
  let grants = 0;
  const copy = value => value == null ? null : structuredClone(value);
  const database = {
    getSetting: name => settings.get(name), saveSetting: (name, value) => settings.set(name, value),
    upsertATokenActivationRow: row => { rows.set(row.id, copy(row)); return row; },
    getATokenActivationById: id => copy(rows.get(id)),
    getATokenActivationByTx: tx => copy([...rows.values()].find(row => row.txHash === tx)),
    listATokenActivations: () => [...rows.values()].map(copy),
    listATokenActivationsByWallet: wallet => [...rows.values()].filter(row => row.wallet.toLowerCase() === wallet.toLowerCase()).map(copy),
    listATokenMiners: wallet => miners.filter(row => row.wallet.toLowerCase() === wallet.toLowerCase()).map(copy),
    countConfirmedATokenActivations: () => [...rows.values()].filter(row => row.status === 'confirmed').length,
    countConfirmedATokenActivationsByPlan: () => (expectedRotation ? 1 : 0),
    countATokenActivationsByWalletPlan: (wallet, plan) => [...rows.values()].filter(row =>
      row.wallet.toLowerCase() === wallet.toLowerCase() && row.plan === plan && ['pending', 'confirmed'].includes(row.status)).length,
  };
  const provider = {
    getTransaction: async () => ({ from: wallet, to: actualTo, value }),
    getTransactionReceipt: async () => ({ status: receiptStatus, blockNumber: 100 }),
    getBlockNumber: async () => 100 + confirmations,
    // The AIX candidate permits historical BNB recovery; the BNB candidate ignores this.
    getBlock: async () => ({ timestamp: Math.floor(now / 1000) - 60 }),
  };
  const service = createATokenActivationService({
    database, clock: () => now,
    aTokenService: { transaction: callback => callback(), getActivationMeta: () => ({}) },
    minerService: { createMiner: (wallet, plan, details = {}) => miners.push({ id: `miner_${index}`, wallet, plan, ...details }) },
    onConfirmed: () => { grants += 1; },
    collectionAddress: main, rotationAddressesByPlan: `2:${rotation}`,
    rotationPlan: '2', rotationEveryByPlan: '2:2',
    providerOverride: provider,
  });
  const record = service.submit(wallet, '2', hash(index));
  assert.equal(record.payload.collectionAddress.toLowerCase(), expectedRotation ? rotation : main);
  assert.equal(record.payload.verifiedCollectionAddress, undefined, 'Submitting an expected recipient does not verify it');
  return { service, record, database, miners, get grants() { return grants; } };
}

const confirmed = [];
for (const options of [
  { expectedRotation: false, actualTo: rotation.toUpperCase() },
  { expectedRotation: true, actualTo: main.toUpperCase() },
]) {
  const current = fixture(options);
  const result = await current.service.verify(current.record);
  assert.equal(result.status, 'confirmed', result.reason);
  const saved = current.database.getATokenActivationById(current.record.id);
  assert.equal(saved.payload.collectionAddress.toLowerCase(), options.expectedRotation ? rotation : main,
    'Keep the submitted quote for audit');
  assert.equal(saved.payload.verifiedCollectionAddress, options.actualTo.toLowerCase(),
    'Only the actual chain recipient determines verifiedCollectionAddress');
  assert.equal(current.miners.length, 1);
  assert.equal(current.miners[0].plan, 'pro1500');
  assert.equal(current.grants, 1);
  const state = JSON.stringify(saved);
  for (const retry of [saved, result.record]) {
    assert.equal((await current.service.verify(retry)).status, 'confirmed');
  }
  assert.equal(current.miners.length, 1, 'Repeated verification cannot create an additional miner');
  assert.equal(current.grants, 1, 'Repeated verification cannot grant activation points twice');
  assert.equal(JSON.stringify(current.database.getATokenActivationById(saved.id)), state, 'Confirmed retries do not rewrite the activation');
  confirmed.push(saved);
}

for (const [options, expectedStatus, reason] of [
  [{ actualTo: rotation, value: proWei - 1n }, 'rejected', /金额/],
  [{ actualTo: address(901) }, 'rejected', /收款地址/],
  [{ actualTo: rotation, receiptStatus: 0 }, 'rejected', /链上交易失败/],
  [{ actualTo: rotation, confirmations: 1 }, 'pending', /区块确认/],
]) {
  const current = fixture(options);
  const result = await current.service.verify(current.record);
  assert.equal(result.status, expectedStatus, result.reason);
  assert.match(result.reason, reason);
  assert.equal(current.record.payload.verifiedCollectionAddress, undefined, 'Failed checks cannot attest a recipient in memory');
  assert.equal(current.database.getATokenActivationById(current.record.id).payload.verifiedCollectionAddress, undefined,
    'Failed checks cannot persist a verified recipient');
  assert.equal(current.miners.length, 0);
  assert.equal(current.grants, 0);
}

const tempBase = fs.realpathSync(os.tmpdir());
const tempRoot = fs.mkdtempSync(path.join(tempBase, 'a-token-pro-recipient-'));
try {
  const database = openDatabase(tempRoot);
  const insertWallet = database.db.prepare('INSERT INTO wallet_users(address,balances_json,created_at,updated_at,payload_json) VALUES(?,?,?,?,?)');
  const seed = (id, payload, status = 'confirmed') => ({
    id, wallet: address(100), plan: '2', bnbAmountWei: proWei.toString(), txHash: hash(100 + id.length),
    status, blockNumber: 100, confirmedAt: status === 'confirmed' ? 1000 : null, createdAt: 1000, payload,
  });
  const synthetic = [
    seed('legacy_main', { collectionAddress: main }),
    seed('legacy_rotation', { collectionAddress: rotation.toUpperCase() }),
    seed('pending_recipient', { collectionAddress: main, verifiedCollectionAddress: rotation }, 'pending'),
    seed('rejected_recipient', { collectionAddress: main, verifiedCollectionAddress: rotation }, 'rejected'),
  ];
  const all = [...confirmed, ...synthetic].map((row, index) => ({ ...row, txHash: hash(1000 + index) }));
  for (const wallet of new Set(all.map(row => row.wallet))) insertWallet.run(wallet, '{}', 1000, 1000, JSON.stringify({ address: wallet, balances: {} }));
  for (const row of all) database.upsertATokenActivationRow(row);
  const actualRotation = database.listConfirmedATokenActivationsByCollection(rotation.toUpperCase());
  const actualMain = database.listConfirmedATokenActivationsByCollection(main.toUpperCase());
  assert.deepEqual(new Set(actualRotation.map(row => row.id)), new Set([confirmed[0].id, 'legacy_rotation']),
    'SQLite uses verified rotation recipient first and falls back to the expected recipient only for legacy rows');
  assert.deepEqual(new Set(actualMain.map(row => row.id)), new Set([confirmed[1].id, 'legacy_main']),
    'A verified main recipient cannot be classified as rotation merely because rotation was expected');
  assert.equal(actualRotation.find(row => row.id === confirmed[0].id).payload.verifiedCollectionAddress, rotation,
    'The metadata produced by verify survives real SQLite persistence and lookup');
  assert.equal(actualMain.find(row => row.id === confirmed[1].id).payload.verifiedCollectionAddress, main);
  assert.equal(database.listConfirmedATokenActivationsByCollection(address(999)).length, 0);
  for (const row of all) assert.deepEqual(database.getATokenActivationByTx(row.txHash), row, 'Recipient reporting reads preserve the stored records');
} finally {
  closeDatabase(tempRoot);
  const resolvedRoot = fs.realpathSync(tempRoot);
  const relative = path.relative(tempBase, resolvedRoot);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Cleanup must stay inside the temporary directory');
  assert.ok(path.basename(resolvedRoot).startsWith('a-token-pro-recipient-'));
  assert.equal(resolvedRoot, path.resolve(tempRoot), 'Cleanup must target only the directory created by this test');
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}

console.log('PASS Pro actual-recipient verification and SQLite lookup: both quote/payment directions, invalid-payment isolation, idempotent grants, legacy fallback and pending exclusion');
