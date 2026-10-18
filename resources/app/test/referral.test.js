import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../src/database.js';
import { createReferralService } from '../src/referral-service.js';
import { createPlatformService } from '../src/platform-service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-referral-test-'));
const addresses = Array.from({ length:9 }, (_, i) => `0x${String(i + 1).padStart(40, '0')}`);
const [rootUser, directUser, indirectUser, ...otherDirect] = addresses;
try {
  const database = openDatabase(root);
  database.replaceWalletState({ version:5, users:Object.fromEntries(addresses.map(address => [address, { address, balances:{ USDT:'0' }, createdAt:new Date(0).toISOString(), updatedAt:new Date(0).toISOString() }])), sessions:{}, deposits:[], withdrawals:[] });
  const balances = new Map(addresses.map(address => [address, 0n]));
  const walletService = {
    balanceUnits(address) { return balances.get(address) || 0n; },
    creditBalance(address, _asset, value) { balances.set(address, (balances.get(address) || 0n) + BigInt(value)); },
    debitBalance(address, _asset, value) { const amount=BigInt(value), current=balances.get(address)||0n; if(current<amount) throw new Error('insufficient'); balances.set(address,current-amount); },
  };
  const service = createReferralService({ database, walletService });
  const rootLink = service.ensure(rootUser);
  const directLink = service.ensure(directUser, rootLink.code);
  for (const address of otherDirect) service.ensure(address, rootLink.code);
  service.ensure(indirectUser, directLink.code);
  for (const address of [directUser, ...otherDirect, indirectUser]) database.upsertAiBatch({ id:`batch_${address}`, wallet:address, status:'active', principalUnits:'100000000', startedAt:0, expiresAt:9999999999999 });

  const profile = service.profile(rootUser);
  assert.equal(profile.directValid, 7);
  assert.equal(profile.directInvalid, 0);
  assert.equal(profile.indirectValid, 1);
  assert.equal(profile.directRate, 0.1);
  assert.equal(profile.indirectRate, 0);

  service.distributeAiReward(indirectUser, 100_000_000n, { id:`batch_${indirectUser}` }, 1000);
  assert.equal(balances.get(directUser), 0n, '推荐奖励需手动领取，不自动入余额');
  assert.equal(service.profile(directUser).claimable, '10.0');
  assert.equal(balances.get(rootUser), 0n, '仅 1 代直推，间接上级不再获得奖励');
  service.distributeAiReward(indirectUser, 100_000_000n, { id:`batch_${indirectUser}` }, 1000);
  assert.equal(service.profile(directUser).claimable, '10.0', '重复结算不重复累计');
  assert.equal(service.claim(directUser).amount, '10.0');
  assert.equal(balances.get(directUser), 10_000_000n);
  assert.equal(service.claim(directUser).amount, '0.0', '不能重复领取');
  service.distributeTradingFee(directUser, 1_000_000n, 'fill_001', 2000);
  assert.equal(balances.get(rootUser), 0n, '手续费返佣也需手动领取');
  service.distributeTradingFee(directUser, 1_000_000n, 'fill_001', 2000);
  assert.equal(service.profile(rootUser).claimable, '0.5', '同一成交手续费不得重复返佣');
  service.claim(rootUser);
  assert.equal(balances.get(rootUser), 500_000n);
  balances.set(directUser, 1_000_000_000n);
  const platform = createPlatformService({ dataRoot:root, walletService });
  platform.setReferralService(service);
  platform.spotTrade(directUser, { symbol:'BTC', side:'buy', size:'0.01', price:'60000' });
  assert.equal(balances.get(rootUser), 500_000n, '成交新增返佣先进入待领取');
  assert.equal(service.profile(rootUser).claimable, '0.15');
  service.claim(rootUser);
  assert.equal(balances.get(rootUser), 650_000n, '手动领取后余额增加');
  console.log('referral tests passed');
} finally {
  closeDatabase(root);
  fs.rmSync(root, { recursive:true, force:true });
}
