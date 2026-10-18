import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWalletService } from '../src/wallet-service.js';
import { createPlatformService } from '../src/platform-service.js';
import { closeDatabase } from '../src/database.js';

const walletRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-corrupt-wallet-test-'));
const platformRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-corrupt-platform-test-'));
const walletMock = { beginAtomicUpdate:() => null, balanceUnits:() => 0n, debitBalance() {}, creditBalance() {} };

try {
  fs.writeFileSync(path.join(walletRoot, 'wallet-accounts.json'), '{broken', 'utf8');
  assert.throws(() => createWalletService({ dataRoot:walletRoot, networks:[] }), /账本损坏/);
  assert.equal(fs.readdirSync(walletRoot).some(file => file.includes('.corrupt-')), true);

  fs.writeFileSync(path.join(platformRoot, 'platform-accounts.json'), '{broken', 'utf8');
  assert.throws(() => createPlatformService({ dataRoot:platformRoot, walletService:walletMock }), /账本损坏/);
  assert.equal(fs.readdirSync(platformRoot).some(file => file.includes('.corrupt-')), true);

  const semanticWalletRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-corrupt-wallet-shape-test-'));
  fs.writeFileSync(path.join(semanticWalletRoot, 'wallet-accounts.json'), JSON.stringify({ users:[], sessions:{}, deposits:[], withdrawals:[] }), 'utf8');
  assert.throws(() => createWalletService({ dataRoot:semanticWalletRoot, networks:[] }), /账本损坏/);
  closeDatabase(semanticWalletRoot);
  fs.rmSync(semanticWalletRoot, { recursive:true, force:true });

  const invalidBalanceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-corrupt-wallet-balance-test-'));
  fs.writeFileSync(path.join(invalidBalanceRoot, 'wallet-accounts.json'), JSON.stringify({
    users:{ '0x0000000000000000000000000000000000000001': { address:'0x0000000000000000000000000000000000000001', balances:{ USDT:'NaN' } } },
    sessions:{}, deposits:[], withdrawals:[],
  }), 'utf8');
  assert.throws(() => createWalletService({ dataRoot:invalidBalanceRoot, networks:[] }), /账本损坏/);
  assert.equal(fs.readdirSync(invalidBalanceRoot).some(file => file.includes('.corrupt-')), true);
  closeDatabase(invalidBalanceRoot);
  fs.rmSync(invalidBalanceRoot, { recursive:true, force:true });

  const semanticPlatformRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-corrupt-platform-shape-test-'));
  fs.writeFileSync(path.join(semanticPlatformRoot, 'platform-accounts.json'), JSON.stringify({ accounts:{}, orders:{}, fills:[], audit:[] }), 'utf8');
  assert.throws(() => createPlatformService({ dataRoot:semanticPlatformRoot, walletService:walletMock }), /账本损坏/);
  closeDatabase(semanticPlatformRoot);
  fs.rmSync(semanticPlatformRoot, { recursive:true, force:true });
  console.log('corrupt-ledger tests passed');
} finally {
  closeDatabase(walletRoot);
  closeDatabase(platformRoot);
  fs.rmSync(walletRoot, { recursive:true, force:true });
  fs.rmSync(platformRoot, { recursive:true, force:true });
}
