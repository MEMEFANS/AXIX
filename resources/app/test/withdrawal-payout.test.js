import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Interface, Wallet } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { createWithdrawalPayoutService } from '../src/withdrawal-payout-service.js';
import { closeDatabase } from '../src/database.js';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-withdrawal-payout-test-'));
const signerWallet = Wallet.createRandom();
const userWallet = Wallet.createRandom();

// 提现必须由用户钱包 personal_sign 签名（消息格式与 wallet-service.verifyOperationSignature 一致）
const signedWithdrawalBody = async (user, body) => {
  const timestamp = String(Date.now());
  const message = `AxiX 提现确认：${body.amount} ${body.asset ?? 'USDT'}，编号 ${body.requestId}，时间：${timestamp}`;
  return { ...body, timestamp, signature: await user.signMessage(message) };
};
const tokenContract = '0x55d398326f99059fF775485246999027B3197955';
const token = new Interface(['function balanceOf(address owner) view returns (uint256)']);
let broadcastCount = 0;
let receiptAvailable = true;
let failSigning = false;
let nextNonce = 7;
let platformBalanceRaw = 10_000n * 10n ** 18n;
const provider = {
  async call() { return token.encodeFunctionResult('balanceOf', [platformBalanceRaw]); },
  async broadcastTransaction() { broadcastCount += 1; return {}; },
  async getTransaction() { return broadcastCount ? {} : null; },
  async getTransactionReceipt() { return receiptAvailable ? { status:1, blockNumber:100 } : null; },
  async getBlockNumber() { return 110; },
};
const signer = {
  address:signerWallet.address,
  async populateTransaction(transaction) { return { ...transaction, nonce:nextNonce++ }; },
  async signTransaction(transaction) {
    if (failSigning) throw new Error('signer unavailable');
    return `0x${Number(transaction.nonce).toString(16).padStart(4, '0')}`;
  },
};
const network = {
  id:'bsc', name:'BNB Smart Chain', chainId:56, provider, signer,
  rpcUrl:'', tokenContract, tokenDecimals:18, confirmations:10,
};

try {
  const walletService = createWalletService({
    dataRoot,
    withdrawalAddress:signerWallet.address,
    autoWithdrawalEnabled:true,
    autoWithdrawalReviewThresholdUsdt:'15',
    autoWithdrawalDailyLimitUsdt:'45',
    networks:[network],
  });
  walletService.creditBalance(userWallet.address, 'USDT', 60_000000n);

  const small = walletService.requestWithdrawal(userWallet.address, await signedWithdrawalBody(userWallet, {
    asset:'USDT', network:'bsc', amount:'10', requestId:'auto_small_0001',
  }));
  assert.equal(small.status, 'pending_auto');

  const payoutService = createWithdrawalPayoutService({
    walletService,
    networks:[network],
    withdrawalAddress:signerWallet.address,
    privateKey:signerWallet.privateKey,
    enabled:true,
    isEnabled:() => walletService.withdrawalAutomationSettings().enabled,
  });
  await payoutService.enqueue(small.id);
  assert.equal(walletService.payoutRecord(small.id).status, 'paid');
  assert.equal(broadcastCount, 1);

  const large = walletService.requestWithdrawal(userWallet.address, await signedWithdrawalBody(userWallet, {
    asset:'USDT', network:'bsc', amount:'20', requestId:'auto_large_0001',
  }));
  assert.equal(large.status, 'pending_review');
  const released = await walletService.adminProcessWithdrawal(large.id, { action:'release' });
  assert.equal(released.status, 'pending_auto');
  await payoutService.enqueue(large.id);
  assert.equal(walletService.payoutRecord(large.id).status, 'paid');
  assert.equal(broadcastCount, 2);
  assert.equal(walletService.balanceUnits(userWallet.address), 30_000000n, '自动出款和人工放行不能重复扣款');

  failSigning = true;
  const failed = walletService.requestWithdrawal(userWallet.address, await signedWithdrawalBody(userWallet, {
    asset:'USDT', network:'bsc', amount:'10.5', requestId:'auto_failed_0001',
  }));
  await payoutService.enqueue(failed.id);
  // 瞬时失败自动重试机制：签名失败不退款不判死，回到待出款队列按延迟自动重试
  assert.equal(walletService.payoutRecord(failed.id).status, 'pending_auto');
  failSigning = false;
  await new Promise(resolve => setTimeout(resolve, 17_000));
  assert.equal(walletService.payoutRecord(failed.id).status, 'paid');

  receiptAvailable = false;
  const confirming = walletService.requestWithdrawal(userWallet.address, await signedWithdrawalBody(userWallet, {
    asset:'USDT', network:'bsc', amount:'10.1', requestId:'auto_confirm_0001',
  }));
  await payoutService.enqueue(confirming.id);
  assert.equal(walletService.payoutRecord(confirming.id).status, 'broadcast');
  await assert.rejects(
    walletService.adminProcessWithdrawal(confirming.id, { action:'reject', reason:'unsafe refund' }),
    /不能退款/,
  );
  receiptAvailable = true;
  await payoutService.enqueue(confirming.id);
  assert.equal(walletService.payoutRecord(confirming.id).status, 'paid');
  assert.equal(walletService.balanceUnits(userWallet.address), 9_400000n);

  walletService.creditBalance(userWallet.address, 'USDT', 20_000000n);
  const splitLimit = walletService.requestWithdrawal(userWallet.address, await signedWithdrawalBody(userWallet, {
    asset:'USDT', network:'bsc', amount:'14.5', requestId:'auto_daily_limit_0001',
  }));
  assert.equal(splitLimit.status, 'pending_review', '拆分小额不能绕过 24 小时自动出款额度');

  // === 平台出款钱包余额不足：挂起待人工补币放行，不自动退款，用户端仍显示提现中 ===
  // 提高日限额，避免新增测试单被 24 小时自动额度拦截（后续关闭自动提现时会重新设置）
  walletService.updateWithdrawalAutomationSettings({ enabled:true, reviewThresholdUsdt:'15', dailyLimitUsdt:'200' });
  walletService.creditBalance(userWallet.address, 'USDT', 12_000000n);
  platformBalanceRaw = 0n;
  const awaiting = walletService.requestWithdrawal(userWallet.address, await signedWithdrawalBody(userWallet, {
    asset:'USDT', network:'bsc', amount:'12', requestId:'auto_funds_0001',
  }));
  // 提现申请已扣款；挂起期间余额必须保持不变（不退款、不重复扣）
  const balanceHeld = walletService.balanceUnits(userWallet.address);
  await payoutService.enqueue(awaiting.id);
  const awaitingRecord = walletService.payoutRecord(awaiting.id);
  assert.equal(awaitingRecord.status, 'pending_funds');
  assert.equal(walletService.balanceUnits(userWallet.address), balanceHeld, '余额不足挂起不能退款给用户');
  // 人工补币后放行：重新进入自动出款队列并正常到账
  platformBalanceRaw = 10_000n * 10n ** 18n;
  const fundsReleased = await walletService.adminProcessWithdrawal(awaiting.id, { action:'release' });
  assert.equal(fundsReleased.status, 'pending_auto');
  await payoutService.enqueue(awaiting.id);
  assert.equal(walletService.payoutRecord(awaiting.id).status, 'paid');
  assert.equal(walletService.balanceUnits(userWallet.address), balanceHeld, '放行出款后余额与挂起期间一致（不重复扣款）');

  const queuedBeforeDisable = walletService.requestWithdrawal(userWallet.address, await signedWithdrawalBody(userWallet, {
    asset:'USDT', network:'bsc', amount:'10', requestId:'auto_disable_0001',
  }));
  assert.equal(queuedBeforeDisable.status, 'pending_auto');
  const disabledSettings = walletService.updateWithdrawalAutomationSettings({
    enabled:false,
    reviewThresholdUsdt:'5',
    dailyLimitUsdt:'10',
  });
  assert.equal(disabledSettings.enabled, false);
  assert.equal(payoutService.status().enabled, false);
  assert.equal(disabledSettings.reviewThresholdUsdt, '5.0');
  assert.equal(walletService.payoutRecord(queuedBeforeDisable.id).status, 'pending_review');
  assert.throws(() => walletService.updateWithdrawalAutomationSettings({
    enabled:true, reviewThresholdUsdt:'0', dailyLimitUsdt:'10',
  }), /必须大于 0/);

  const restartedWalletService = createWalletService({
    dataRoot,
    withdrawalAddress:signerWallet.address,
    autoWithdrawalEnabled:true,
    autoWithdrawalReviewThresholdUsdt:'999',
    networks:[network],
  });
  assert.deepEqual(
    restartedWalletService.withdrawalAutomationSettings(),
    disabledSettings,
    '后台自动提现设置必须在重启后保持不变',
  );

  assert.throws(() => createWithdrawalPayoutService({
    walletService,
    networks:[network],
    withdrawalAddress:Wallet.createRandom().address,
    privateKey:signerWallet.privateKey,
    enabled:true,
  }), /不匹配/);
  assert.throws(() => createWithdrawalPayoutService({
    walletService,
    networks:[network],
    withdrawalAddress:signerWallet.address,
    enabled:true,
  }), /未配置 PLATFORM_WITHDRAWAL_PRIVATE_KEY/);

  console.log('withdrawal payout tests passed');
} finally {
  closeDatabase(dataRoot);
  fs.rmSync(dataRoot, { recursive:true, force:true });
}
