import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet, parseUnits } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { closeDatabase, openDatabase } from '../src/database.js';
import { createATokenService } from '../src/a-token-service.js';
import { createATokenMinerService } from '../src/a-token-miner-service.js';
import { createATokenActivationService, activationMessage } from '../src/a-token-activation-service.js';
import { createATokenApi } from '../src/a-token-api.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aix-activation-'));
const A = n => parseUnits(String(n), 18);
const main = Wallet.createRandom().address;
let now = Date.now();
const clock = () => now;
const ws = createWalletService({ dataRoot: root, depositAddress: main, networks: [] });
const db = ws.database;
const at = createATokenService({ database: db, walletService: ws, clock });
const miners = createATokenMinerService({ aTokenService: at, database: db, clock });
let points = 0;
const options = { aTokenService: at, minerService: miners, database: db, clock, collectionAddress: main,
  onConfirmed: () => { points++; } };
let svc = createATokenActivationService(options);
const user = Wallet.createRandom();
ws.creditBalance(user.address, 'A', A(2000));
const key = suffix => 'activation_request_' + suffix;
const snapshot = () => JSON.stringify({ balance: ws.balanceUnits(user.address, 'A').toString(),
  storedBalance: db.loadWalletState().users[user.address.toLowerCase()].balances.A,
  pool: at.getPoolMeta(), miners: db.listATokenMiners(user.address), activations: db.listATokenActivationsByWallet(user.address),
  burns: db.db.prepare('SELECT * FROM a_token_burns ORDER BY id').all() });
try {
  assert.equal(svc.getMeta().cap, null);
  assert.equal(svc.getMeta().unlimited, true);
  const mini = svc.activate(user.address, '1', key('mini'));
  assert.equal(ws.balanceUnits(user.address, 'A'), A(1980));
  assert.equal(at.totalBurned(), A(20));
  assert.equal(BigInt(at.getPoolMeta().todayBurnedUnits), A(20));
  assert.equal(mini.txHash, null, 'Internal payments must not invent chain hashes');
  assert.equal(mini.amountUnits, A(20).toString());
  const miniMiner = db.listATokenMiners(user.address)[0];
  assert.equal(miniMiner.totalUnits, A(100).toString());
  assert.equal(miniMiner.expiresAt - miniMiner.startedAt, 30 * 86400000);
  assert.throws(() => svc.activate(user.address, '1', key('mini_again')), /终身/);
  miniMiner.status = 'completed'; db.upsertATokenMinerRow(miniMiner);
  assert.throws(() => svc.activate(user.address, '1', key('mini_expired')), /终身/);
  const beforeRetry = snapshot();
  svc = createATokenActivationService(options);
  assert.equal(svc.activate(user.address.toLowerCase(), '1', key('mini')).id, mini.id);
  assert.equal(snapshot(), beforeRetry, 'Durable replay does not alter balance, burn, miner or record');
  assert.equal(points, 1);
  assert.throws(() => svc.activate(user.address, '2', key('mini')), /其他套餐/);
  assert.throws(() => svc.adminReject(mini.id), /不能驳回/);
  for (const i of [1, 2, 3]) svc.activate(user.address, '2', key('pro_' + i));
  assert.equal(ws.balanceUnits(user.address, 'A'), A(780));
  assert.equal(at.totalBurned(), A(1220));
  assert.equal(at.poolStats().totalBurned, '1220.0', 'Trading hall pool total includes activation burns');
  const pro = db.listATokenMiners(user.address).filter(m => m.plan === 'pro1500');
  assert.equal(pro.length, 3);
  assert.equal(new Set(pro.map(m => m.id)).size, 3);
  assert.ok(pro.every(m => m.totalUnits === A(1500).toString() && m.expiresAt - m.startedAt === 90 * 86400000));
  assert.equal(points, 4);
  console.log('PASS exact 20/400 AIX full burns, Mini lifetime, unlimited concurrent Pro, durable idempotency, live pool total');

  // Persistence failures at each economic boundary must roll back SQL and memory.
  for (const [target, property] of [[at, 'burn'], [db, 'upsertATokenActivationRow'], [miners, 'createMiner']]) {
    const before = snapshot(), original = target[property];
    target[property] = (...args) => { original(...args); throw new Error('injected failure'); };
    try { assert.throws(() => svc.activate(user.address, '2', key('fail_' + property)), /injected/); }
    finally { target[property] = original; }
    assert.equal(snapshot(), before, property + ' must roll back every economic change');
  }
  const hookSvc = createATokenActivationService({ ...options, onConfirmed: () => { throw new Error('hook failure'); } });
  let before = snapshot();
  assert.throws(() => hookSvc.activate(user.address, '2', key('fail_hook')), /hook/);
  assert.equal(snapshot(), before);
  const oldReplace = db.replaceWalletStateInside;
  db.replaceWalletStateInside = () => { throw new Error('wallet persist failure'); };
  try { assert.throws(() => svc.activate(user.address, '2', key('fail_commit')), /wallet persist/); }
  finally { db.replaceWalletStateInside = oldReplace; }
  assert.equal(snapshot(), before);
  at.setPoolMeta({ totalBurnedUnits: A(1980000000 - 399).toString() });
  before = snapshot();
  assert.throws(() => svc.activate(user.address, '2', key('burn_cap')), /销毁额度/);
  assert.equal(snapshot(), before, 'Burn ceiling rejects purchase with zero net debit');
  at.setPoolMeta({ totalBurnedUnits: A(1220).toString() });
  console.log('PASS burn/activation/miner/hook/commit failure rollback and global burn ceiling');

  const poor = Wallet.createRandom(); ws.creditBalance(poor.address, 'A', A('19.999999999999999999'));
  assert.throws(() => svc.activate(poor.address, '1', key('poor')), /余额不足/);
  ws.creditBalance(poor.address, 'A', 1n);
  svc.activate(poor.address, '1', key('exact_balance'));
  assert.equal(ws.balanceUnits(poor.address, 'A'), 0n);
  const legacy = Wallet.createRandom(); ws.ensureUser(legacy.address); ws.creditBalance(legacy.address, 'A', A(50));
  miners.createMiner(legacy.address, 'mini120');
  assert.throws(() => svc.activate(legacy.address, '1', key('legacy_mini')), /终身/);
  at.setPoolMeta({ activationEnabled: '0' });
  assert.throws(() => svc.activate(user.address, '2', key('disabled')), /未开放/);
  assert.equal(svc.activate(user.address, '1', key('mini')).id, mini.id, 'Completed retry works even when sales disabled');
  at.setPoolMeta({ activationEnabled: '1' });

  // API uses actual EIP-191 wallet signatures bound to cost, plan and request ID.
  const api = createATokenApi({ aTokenService: at, activationService: svc, minerService: miners, walletService: ws,
    stakingService: { STAKE_PLANS: {} }, send: (res, status, data) => Object.assign(res, { status, data }),
    getSession: request => request.session === false ? null : { address: user.address }, readBody: async request => request.body });
  async function call(body, requestId, method = 'POST', endpoint = '/api/a-token/activate', session = true) {
    const res = {};
    await api.handle({ method, url: endpoint, headers: { 'idempotency-key': requestId || '' }, body, session }, res, endpoint.split('?')[0]);
    return res;
  }
  const timestamp = String(Date.now()), requestId = key('signed_pro');
  const signature = await user.signMessage(activationMessage('2', requestId, timestamp));
  let result = await call({ plan: '2', timestamp, signature }, requestId);
  assert.equal(result.status, 200, result.data?.error);
  const signedId = result.data.activation.record.id;
  before = snapshot();
  result = await call({ plan: '2', timestamp: '1000000000000', signature }, requestId);
  assert.equal(result.data.activation.record.id, signedId, 'Confirmed retry may recover after signature expiry');
  assert.equal(snapshot(), before);
  const other = Wallet.createRandom();
  const errors = [
    [{ plan: '2', timestamp, signature: await other.signMessage(activationMessage('2', key('wrong_wallet'), timestamp)) }, key('wrong_wallet')],
    [{ plan: '2', timestamp: '1000000000000', signature: await user.signMessage(activationMessage('2', key('expired'), '1000000000000')) }, key('expired')],
    [{ plan: '1', timestamp, signature: await user.signMessage(activationMessage('2', key('wrong_plan'), timestamp)) }, key('wrong_plan')],
    [{ plan: '2', timestamp, signature }, ''],
  ];
  for (const [body, id] of errors) assert.equal((await call(body, id)).status, 400);
  assert.equal((await call({}, '', 'POST', '/api/a-token/activate', false)).status, 401);
  assert.equal(snapshot(), before, 'Unauthorized calls never charge');
  const status = await call({}, '', 'GET', `/api/a-token/activation-request?plan=2&requestId=${requestId}`);
  assert.equal(status.data.record.id, signedId);
  console.log('PASS API signatures, wallet/plan/nonce binding, expiry, session, recovery status, disabled sales and exact balance');

  // Legacy BNB: old payments recover, payments after switch cannot create miners.
  const payer = Wallet.createRandom().address; ws.ensureUser(payer);
  const hash = '0x' + 'a'.repeat(64);
  let paidAt = Math.floor(svc.legacyCutoffAt / 1000) - 1;
  const provider = { getTransaction: async () => ({ from: payer, to: main, value: 2n * 10n ** 15n }),
    getTransactionReceipt: async () => ({ status: 1, blockNumber: 1 }), getBlockNumber: async () => 20,
    getBlock: async () => ({ timestamp: paidAt }) };
  const legacySvc = createATokenActivationService({ ...options, providerOverride: provider, rpcUrl: 'http://unused.test' });
  const manualPayer = Wallet.createRandom().address; ws.ensureUser(manualPayer);
  const beforeCutoffClock = now;
  now = svc.legacyCutoffAt - 1000;
  const unverifiedManual = legacySvc.submit(manualPayer, '1', '0x' + 'd'.repeat(64));
  now = svc.legacyCutoffAt + 1000;
  assert.throws(() => legacySvc.adminConfirm(unverifiedManual.id), /需要链上核验/,
    'An old pending BNB row must not bypass payment-time verification through admin confirmation');
  now = beforeCutoffClock;
  const payment = legacySvc.submit(payer, '1', hash);
  paidAt = Math.floor(svc.legacyCutoffAt / 1000) + 10;
  assert.equal((await legacySvc.verify(payment)).status, 'rejected');
  assert.equal(db.listATokenMiners(payer).length, 0);
  const oldPayer = Wallet.createRandom().address; ws.ensureUser(oldPayer);
  provider.getTransaction = async () => ({ from: oldPayer, to: main, value: 2n * 10n ** 15n });
  paidAt = Math.floor(svc.legacyCutoffAt / 1000) - 1;
  const oldPayment = legacySvc.submit(oldPayer, '1', '0x' + 'b'.repeat(64));
  await Promise.all([legacySvc.verify(oldPayment), legacySvc.verify(structuredClone(oldPayment))]);
  assert.equal(db.listATokenMiners(oldPayer).length, 1);
  const mixed = Wallet.createRandom().address; ws.creditBalance(mixed, 'A', A(400));
  svc.activate(mixed, '2', key('mixed_aix'));
  provider.getTransaction = async () => ({ from: mixed, to: main, value: 5n * 10n ** 16n });
  const mixedPayment = legacySvc.submit(mixed, '2', '0x' + 'c'.repeat(64));
  assert.equal((await legacySvc.verify(mixedPayment)).status, 'confirmed');
  assert.equal(db.listATokenMiners(mixed).length, 2, 'An old paid BNB Pro and a new AIX Pro must both exist');
  const cutoff = svc.legacyCutoffAt; now += 86400000;
  assert.equal(createATokenActivationService(options).legacyCutoffAt, cutoff);
  console.log('PASS legacy BNB cutoff survives restart, old-payment recovery and concurrent confirmation');

  const beforeRelease = ws.balanceUnits(user.address, 'A');
  now += 90 * 86400000;
  miners.processAll();
  assert.equal(ws.balanceUnits(user.address, 'A') - beforeRelease, A(6000), 'All four Pro miners independently release their full 1500 AIX');
  assert.ok(db.listATokenMiners(user.address).filter(m => m.plan === 'pro1500').every(m => m.status === 'completed'));
  console.log('PASS repeat Pro miners each preserve their full 90-day yield');

  // Upgrade a pre-existing unconditional hash index with real historical records.
  const legacyHashRow = db.getATokenActivationByTx(hash);
  db.db.prepare("DELETE FROM a_token_activations WHERE tx_hash=''").run();
  db.db.exec(`DROP INDEX a_token_activations_tx_unique; CREATE UNIQUE INDEX a_token_activations_tx_unique ON a_token_activations(tx_hash COLLATE NOCASE)`);
  closeDatabase(root);
  const reopened = openDatabase(root);
  assert.deepEqual(reopened.getATokenActivationByTx(hash), legacyHashRow);
  assert.match(reopened.db.prepare("SELECT sql FROM sqlite_master WHERE name='a_token_activations_tx_unique'").get().sql, /WHERE/);
  console.log('PASS historical SQLite index migration preserves records');
} finally {
  closeDatabase(root);
  fs.rmSync(root, { recursive: true, force: true });
}
