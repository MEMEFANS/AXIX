import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { closeDatabase } from '../src/database.js';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-deleted-account-'));
try {
  const attacker = Wallet.createRandom(), normal = Wallet.createRandom();
  const service = createWalletService({ dataRoot });
  async function login(wallet) {
    const { message } = service.buildLoginChallenge(wallet.address);
    return service.handleLoginSignature({ message, signature:await wallet.signMessage(message) });
  }
  const badLogin = await login(attacker), normalLogin = await login(normal);
  service.creditBalance(normal.address, 'USDT', 123000000n);
  const pending = service.buildLoginChallenge(attacker.address);
  const pendingSignature = await attacker.signMessage(pending.message);
  service.database.saveSetting('wallet_account_blocks', JSON.stringify({ wallets:{ [attacker.address.toLowerCase()]:{ reason:'malicious social submission' } } }));

  // A restart rejects even previously issued sessions and a previously signed challenge.
  const blocked = createWalletService({ dataRoot });
  assert.equal(blocked.getSession(badLogin.token), null);
  assert.throws(() => blocked.handleLoginSignature({ message:pending.message, signature:pendingSignature }), /账户已被封禁/);
  assert.equal(blocked.getSession(normalLogin.token)?.address, normal.address);
  blocked.database.db.prepare('DELETE FROM wallet_users WHERE address=? COLLATE NOCASE').run(attacker.address);
  for (const address of [attacker.address, attacker.address.toLowerCase()]) {
    assert.throws(() => blocked.buildLoginChallenge(address), /账户已被封禁/);
    assert.throws(() => blocked.ensureUser(address), /账户已被封禁/);
    assert.throws(() => blocked.creditBalance(address, 'USDT', 1n), /账户已被封禁/);
    assert.throws(() => blocked.balanceUnits(address), /账户已被封禁/);
  }
  const restarted = createWalletService({ dataRoot });
  assert.throws(() => restarted.ensureUser(attacker.address), /账户已被封禁/);
  assert.equal(restarted.database.db.prepare('SELECT COUNT(*) AS n FROM wallet_users WHERE address=? COLLATE NOCASE').get(attacker.address).n, 0);
  assert.equal(restarted.balanceUnits(normal.address), 123000000n);
  const { message } = restarted.buildLoginChallenge(normal.address);
  const newLogin = restarted.handleLoginSignature({ message, signature:await normal.signMessage(message) });
  assert.equal(restarted.getSession(newLogin.token)?.address, normal.address);
  restarted.database.saveSetting('wallet_account_blocks', '{"wallets":[]}');
  assert.throws(() => createWalletService({ dataRoot }), /封禁名单格式无效/);
  console.log('Deleted-account security tests passed');
} finally {
  closeDatabase(dataRoot);
  fs.rmSync(dataRoot, { recursive:true, force:true });
}
