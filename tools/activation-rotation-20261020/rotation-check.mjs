// Run with: node /path/to/rotation-check.mjs
// Imports production code, but uses only synthetic providers and in-memory state.
// No .env, application database, HTTP requests, or background jobs are used.
import assert from 'node:assert/strict';
import { createATokenActivationService } from '/opt/wg-platform/src/a-token-activation-service.js';

const MAIN = '0xa71e0cfb92643ccf1fadcd45fcfb29b7b39c56e6';
const NEW = '0x1266d38865460cf7d0c06985ac5587a5e85de2c0';
const OLD = '0x0c89b9ddc29f3e4ac968a3e02611bd95a2df1361';
const UNKNOWN = '0x' + 'ee'.repeat(20);
const WEI = 5n * 10n ** 16n;
const rows = new Map();
const transactions = new Map();
const miners = [];
const callbacks = [];
const checks = [];
const settings = new Map();
let sequenceCount = 0;
let now = 1_800_000_000_000;
let networkAttempts = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  networkAttempts++;
  throw new Error('Network access is forbidden in this offline test');
};
const lower = value => String(value).toLowerCase();
const walletRows = wallet => [...rows.values()].filter(row => lower(row.wallet) === lower(wallet));
const database = {
  getSetting: key => settings.get(key),
  saveSetting: (key, value) => settings.set(key, value),
  countConfirmedATokenActivations: () => [...rows.values()].filter(row => row.status === 'confirmed').length,
  countConfirmedATokenActivationsByPlan: plan => sequenceCount ?? [...rows.values()].filter(row => row.plan === String(plan) && row.status === 'confirmed').length,
  countATokenActivationsByWalletPlan: (wallet, plan) => walletRows(wallet).filter(row => row.plan === String(plan) && ['pending', 'confirmed'].includes(row.status)).length,
  getATokenActivationByTx: hash => [...rows.values()].find(row => lower(row.txHash) === lower(hash)) || null,
  getATokenActivationById: id => rows.get(id) || null,
  upsertATokenActivationRow: row => rows.set(row.id, row),
  listATokenActivations: (limit = 5000) => [...rows.values()].slice(0, limit),
  listATokenActivationsByWallet: walletRows,
  listATokenMiners: wallet => miners.filter(miner => lower(miner.wallet) === lower(wallet)),
};
const provider = {
  getTransaction: async hash => transactions.get(hash) || null,
  getTransactionReceipt: async hash => transactions.has(hash) ? { status: 1, blockNumber: 100 } : null,
  getBlockNumber: async () => 200,
  getBlock: async () => ({ timestamp: Math.floor(now / 1000) - 60 }),
};
const originalLog = console.log;
console.log = () => {};
let service;
try { service = createATokenActivationService({
  database,
  aTokenService: {
    transaction: callback => callback(),
    getActivationMeta: () => ({ cap: 1_000_000 }),
  },
  minerService: {
    createMiner(wallet, plan, options) {
      const miner = { id: `test-miner-${miners.length + 1}`, wallet, plan, ...options };
      miners.push(miner);
      return miner;
    },
  },
  clock: () => ++now,
  collectionAddress: MAIN,
  // This sentinel must never be requested; providerOverride supplies every RPC result.
  rpcUrl: 'http://offline.invalid',
  providerOverride: provider,
  confirmations: 12,
  rotationPlan: '2',
  rotationAddressesByPlan: `2:${NEW}`,
  rotationEvery: 3,
  rotationEveryByPlan: '2:2',
  extraCollectionAddresses: OLD,
  onConfirmed: (wallet, plan) => callbacks.push({ wallet, plan }),
}); } finally { console.log = originalLog; }

try {
  assert.equal(service.getPlans().find(plan => plan.plan === '2')?.bnb, '0.05', 'This check targets the production BNB activation module');
  for (const count of [0, 1, 2, 3, 4, 5, 1743, 1744, 1745, 1746]) {
    sequenceCount = count;
    assert.equal(lower(service.getCollectionAddressForPlan('2')), count % 2 === 0 ? MAIN : NEW, `Plan 2 at ${count} confirmed payments`);
    assert.equal(lower(service.getCollectionAddressForPlan('1')), MAIN, `Plan 1 must keep its main address at count ${count}`);
  }
  checks.push('Plan 2 alternates at counts 0..5 and 1743..1746', 'Plan 1 keeps main address');
  sequenceCount = null;

  async function payment(number, to, value) {
    const wallet = '0x' + number.toString(16).padStart(40, '0');
    const hash = '0x' + number.toString(16).padStart(64, '0');
    transactions.set(hash, { from: wallet, to, value });
    const record = service.submit(wallet, '2', hash);
    return { wallet, record, result: await service.verify(record) };
  }
  for (const [number, address, label] of [[1, NEW, 'new rotation'], [2, OLD, 'historical rotation']]) {
    const beforeMiners = miners.length;
    const beforeCallbacks = callbacks.length;
    const { wallet, record, result } = await payment(number, address, WEI);
    assert.equal(result.status, 'confirmed', `${label} 0.05 BNB must confirm: ${result.reason || ''}`);
    assert.equal(miners.length, beforeMiners + 1, `${label} creates exactly one miner`);
    assert.equal(miners.at(-1).plan, 'pro1500');
    assert.equal(lower(miners.at(-1).wallet), lower(wallet));
    assert.equal(callbacks.length, beforeCallbacks + 1, `${label} triggers exactly one callback`);
    assert.deepEqual(callbacks.at(-1), { wallet, plan: '2' });
    const repeat = await service.verify(record);
    assert.equal(repeat.status, 'confirmed');
    assert.equal(miners.length, beforeMiners + 1, `${label} repeated verify must not create another miner`);
    assert.equal(callbacks.length, beforeCallbacks + 1, `${label} repeated verify must not repeat callback`);
    checks.push(`${label} 0.05 BNB confirms, grants one Pro miner and one callback; repeated verify is idempotent`);
  }

  const beforeMiners = miners.length;
  const beforeCallbacks = callbacks.length;
  const wrongAmount = await payment(3, NEW, WEI - 1n);
  assert.equal(wrongAmount.result.status, 'rejected');
  assert.equal(wrongAmount.result.reason, 'BNB 金额不符');
  const unknownAddress = await payment(4, UNKNOWN, WEI);
  assert.equal(unknownAddress.result.status, 'rejected');
  assert.equal(unknownAddress.result.reason, '收款地址不符');
  assert.equal(miners.length, beforeMiners, 'Rejected payments must not create miners');
  assert.equal(callbacks.length, beforeCallbacks, 'Rejected payments must not trigger callbacks');
  assert.equal(networkAttempts, 0, 'No real network requests are permitted');
  checks.push('wrong amount and unknown collection address reject without miners or callbacks');
  console.log(JSON.stringify({ passed: checks.length, checks, realNetworkCalls: networkAttempts, productionDatabaseWrites: 0 }));
} finally {
  globalThis.fetch = originalFetch;
}
