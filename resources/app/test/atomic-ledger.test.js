import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitLedgerStates, recoverLedgerTransaction, writeJsonAtomic } from '../src/atomic-ledger.js';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-ledger-txn-test-'));
const walletState = { version:3, users:{}, sessions:{}, deposits:[], withdrawals:[] };
const platformState = { version:2, accounts:{}, orders:[], fills:[], audit:[], insuranceFundUnits:'0', badDebtUnits:'0', lastFundingAt:Date.now() };

try {
  commitLedgerStates(dataRoot, walletState, platformState);
  assert.equal(fs.existsSync(path.join(dataRoot, 'platform-ledger-transaction.json')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataRoot, 'wallet-accounts.json'), 'utf8')), walletState);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataRoot, 'platform-accounts.json'), 'utf8')), platformState);

  const recoveredWallet = { ...walletState, users:{ '0x1': { balances:{ USDT:'4' } } } };
  const recoveredPlatform = { ...platformState, accounts:{ '0x1': { spotBtcUnits:'2' } } };
  writeJsonAtomic(path.join(dataRoot, 'platform-ledger-transaction.json'), {
    version:1, id:'txn_crash_test', createdAt:new Date().toISOString(),
    walletState:recoveredWallet, platformState:recoveredPlatform,
  });
  assert.equal(recoverLedgerTransaction(dataRoot), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataRoot, 'wallet-accounts.json'), 'utf8')), recoveredWallet);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataRoot, 'platform-accounts.json'), 'utf8')), recoveredPlatform);
  assert.equal(recoverLedgerTransaction(dataRoot), false);
  console.log('atomic-ledger tests passed');
} finally {
  fs.rmSync(dataRoot, { recursive:true, force:true });
}
