import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet, parseUnits } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { createATokenWithdrawalService } from '../src/a-token-withdrawal-service.js';
import { closeDatabase } from '../src/database.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'withdraw-security-'));
const user = Wallet.createRandom(), contract = Wallet.createRandom().address;
const walletService = createWalletService({ dataRoot: root, networks: [] });
const database = walletService.database;
walletService.creditBalance(user.address, 'A', parseUnits('1000000', 18));
let receipt = null, block = 100;
const service = createATokenWithdrawalService({
  walletService, database, contractAddress: contract,
  signer: { address: Wallet.createRandom().address },
  provider: {
    getTransactionReceipt: async () => receipt,
    getBlockNumber: async () => block,
    broadcastTransaction: async () => { throw new Error('RPC 失败: timeout'); },
    getTransaction: async () => null,
  },
  aTokenService: {
    balanceA: address => walletService.balanceUnits(address, 'A'),
    debitA: (address, units) => walletService.debitBalance(address, 'A', units),
    creditA: (address, units) => walletService.creditBalance(address, 'A', units),
  },
});
try {
  const original = database.upsertATokenWithdrawalRow;
  const initial = walletService.balanceUnits(user.address, 'A');
  database.upsertATokenWithdrawalRow({ id: 'yesterday', wallet: user.address, requestId: 'yesterday', amountUnits: parseUnits('100000', 18).toString(), feeUnits: '0', needUnits: '0', status: 'paid', createdAt: Date.now()-86400000 });
  database.upsertATokenWithdrawalRow = () => { throw new Error('injected write failure'); };
  assert.throws(() => service.requestWithdrawal({ wallet: user.address, amount: '2000', requestId: 'failed_write' }), /injected/);
  assert.equal(walletService.balanceUnits(user.address, 'A'), initial);
  database.upsertATokenWithdrawalRow = original;
  const record = service.requestWithdrawal({ wallet: user.address, amount: '2000.000000000000000001', requestId: 'stable_id' });
  const held = walletService.balanceUnits(user.address, 'A');
  assert.equal(database.sumATokenWithdrawalsByWalletToday(user.address, new Date().setUTCHours(0,0,0,0)), BigInt(record.amountUnits));
  for (let i = 0; i < 55; i++) database.upsertATokenWithdrawalRow({ ...record, id: 'newer_'+i, requestId: 'other_'+i, status: 'rejected', createdAt: Date.now()+i+1000 });
  assert.equal(service.requestWithdrawal({ wallet: user.address, amount: '2000.000000000000000001', requestId: 'stable_id' }).id, record.id);
  assert.equal(walletService.balanceUnits(user.address, 'A'), held);

  database.upsertATokenWithdrawalRow = () => { throw new Error('injected refund failure'); };
  assert.throws(() => service.cancelWithdrawal({ wallet: user.address, id: record.id }), /injected/);
  assert.equal(walletService.balanceUnits(user.address, 'A'), held);
  database.upsertATokenWithdrawalRow = original;
  database.upsertATokenWithdrawalRow({ ...record, status: 'signed', txHash: '0x'+'a'.repeat(64), rawTransaction: '0x12' });
  await service.enqueue(record.id);
  assert.equal(service.getWithdrawal(record.id).status, 'signed');
  assert.equal(walletService.balanceUnits(user.address, 'A'), held);

  database.upsertATokenWithdrawalRow({ ...service.getWithdrawal(record.id), status: 'broadcast' });
  receipt = { status: 0, blockNumber: 100 };
  await service.enqueue(record.id);
  assert.equal(walletService.balanceUnits(user.address, 'A'), held);
  block = 120;
  await service.enqueue(record.id);
  assert.equal(service.getWithdrawal(record.id).status, 'failed');
  assert.equal(walletService.balanceUnits(user.address, 'A'), initial);
  await service.enqueue(record.id);
  assert.equal(walletService.balanceUnits(user.address, 'A'), initial);
  console.log('PASS: atomic debit/refund rollback, historical retry idempotency, exact daily totals, ambiguous broadcast errors retain funds, confirmed revert refunds once');
} finally { closeDatabase(root); fs.rmSync(root, { recursive: true, force: true }); }
