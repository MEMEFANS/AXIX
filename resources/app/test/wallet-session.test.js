import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Interface, Wallet } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { closeDatabase } from '../src/database.js';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-wallet-session-test-'));

// 提现必须由用户钱包 personal_sign 签名（消息格式与 wallet-service.verifyOperationSignature 一致）
const signedWithdrawalBody = async (userWallet, body) => {
  const timestamp = String(Date.now());
  const message = `AxiX 提现确认：${body.amount} ${body.asset ?? 'USDT'}，编号 ${body.requestId}，时间：${timestamp}`;
  return { ...body, timestamp, signature: await userWallet.signMessage(message) };
};

try {
  const wallet = Wallet.createRandom();
  const tokenContract = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const sender = Wallet.createRandom().address;
  const transfer = new Interface([
    'function transfer(address to, uint256 amount) returns (bool)',
    'event Transfer(address indexed from, address indexed to, uint256 value)',
  ]);
  const paidHash = `0x${'a'.repeat(64)}`;
  const wrongHash = `0x${'b'.repeat(64)}`;
  const raceHash = `0x${'c'.repeat(64)}`;
  let releaseRace;
  const raceGate = new Promise(resolve => { releaseRace = resolve; });
  const amounts = new Map([[paidHash, 10_000000n], [wrongHash, 2_000000n], [raceHash, 10_000000n]]);
  const makeTransfer = (amount) => {
    const data = transfer.encodeFunctionData('transfer', [wallet.address, amount]);
    const log = transfer.encodeEventLog(transfer.getEvent('Transfer'), [sender, wallet.address, amount]);
    return { data, logs:[{ address:tokenContract, topics:log.topics, data:log.data }] };
  };
  const provider = {
    async getTransaction(hash) {
      if (hash === raceHash) await raceGate;
      const amount = amounts.get(hash) || 0n;
      return { chainId:8453n, from:sender, to:tokenContract, data:makeTransfer(amount).data };
    },
    async getTransactionReceipt(hash) {
      const amount = amounts.get(hash) || 0n;
      return { status:1, blockNumber:100, logs:makeTransfer(amount).logs };
    },
    async getBlockNumber() { return 110; },
  };
  // A non-empty URL selects the injected provider in readTxForVerify; no network request is made.
  const network = { id:'base', name:'Base', chainId:8453, provider, rpcUrl:'http://wallet-session.test', tokenContract, confirmations:10 };
  const firstService = createWalletService({ dataRoot, withdrawalAddress:sender, networks:[network] });
  const challenge = firstService.buildLoginChallenge(wallet.address, {requestId:'test_login_0001'});
  assert.deepEqual(firstService.buildLoginChallenge(wallet.address, {requestId:'test_login_0001'}), challenge, '网络重试沿用同一登录挑战，避免乱序请求使签名失效');
  assert.throws(() => firstService.buildLoginChallenge(wallet.address, {requestId:'bad'}), /无效的登录请求编号/);
  assert.equal(typeof challenge.message, 'string', '登录挑战应为纯文本消息');
  assert.match(challenge.message, /^You are sign in AxiX \d{6}$/, '登录消息为极简文本（无 spender/额度）');
  const signature = await wallet.signMessage(challenge.message);
  const login = firstService.handleLoginSignature({ signature, message: challenge.message });
  assert.throws(() => firstService.handleLoginSignature({signature,message:challenge.message}), /登录信息已过期/, '重试挑战不会允许重复使用签名');

  assert.equal(firstService.getSession(login.token)?.address, wallet.address);

  const rewardCreatedAt = Date.now();
  firstService.database.upsertAiBatch({
    id:'aib_profile_test', wallet:wallet.address, status:'active',
    startedAt:rewardCreatedAt, expiresAt:rewardCreatedAt + 86_400_000,
  });
  firstService.database.insertAiReward({
    id:'air_profile_test', batchId:'aib_profile_test', wallet:wallet.address,
    amountUnits:'1250000', rewardDate:'2026-08-17', createdAt:rewardCreatedAt,
    source:'platform',
  });
  firstService.database.insertAiReward({
    id:'air_referral_test', batchId:'aib_profile_test', wallet:wallet.address,
    amountUnits:'100000', rewardDate:'2026-08-17', createdAt:rewardCreatedAt,
    source:'platform', kind:'referral',
  });
  const rewardProfile = await firstService.profile(wallet.address);
  assert.equal(rewardProfile.aiManagedRewards.length, 1, '资产记录只应展示 AI 托管收益');
  assert.equal(rewardProfile.aiManagedRewards[0].amount, '1.25');
  assert.equal(rewardProfile.aiManagedRewards[0].status, 'credited');

  firstService.creditBalance(wallet.address, 'USDT', 20_000_000n);
  const withdrawal = firstService.requestWithdrawal(wallet.address, await signedWithdrawalBody(wallet, {
    asset:'USDT', amount:'10', address:wallet.address, network:'base', requestId:'withdraw_test_0001',
  }));
  assert.equal(withdrawal.address, wallet.address, '提现只能退回当前钱包');
  await assert.rejects(
    async () => firstService.requestWithdrawal(wallet.address, await signedWithdrawalBody(wallet, {
      asset:'USDT', amount:'10', address:Wallet.createRandom().address, network:'base', requestId:'withdraw_test_0002',
    })),
    /提现地址必须与当前连接钱包一致/,
  );
  const retry = firstService.requestWithdrawal(wallet.address, await signedWithdrawalBody(wallet, {
    asset:'USDT', amount:'10', address:wallet.address, network:'base', requestId:'withdraw_test_0001',
  }));
  assert.equal(retry.id, withdrawal.id, '同一提现请求重试不能重复冻结余额');
  assert.equal(firstService.balanceUnits(wallet.address), 10_000_000n);
  await assert.rejects(
    firstService.adminProcessWithdrawal(withdrawal.id, { action:'approve', txHash:wrongHash }),
    /到账金额不匹配/,
  );
  const paid = await firstService.adminProcessWithdrawal(withdrawal.id, { action:'approve', txHash:paidHash });
  assert.equal(paid.status, 'paid');

  const rejectedRequest = firstService.requestWithdrawal(wallet.address, await signedWithdrawalBody(wallet, {
    asset:'USDT', amount:'10', address:wallet.address, network:'base', requestId:'withdraw_test_0003',
  }));
  assert.equal(firstService.balanceUnits(wallet.address), 0n);
  const rejected = await firstService.adminProcessWithdrawal(rejectedRequest.id, { action:'reject', reason:'风控拒绝' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(firstService.balanceUnits(wallet.address), 10_000_000n, '拒绝提现必须原额退回余额');

  const raceRequest = firstService.requestWithdrawal(wallet.address, await signedWithdrawalBody(wallet, {
    asset:'USDT', amount:'10', address:wallet.address, network:'base', requestId:'withdraw_test_0004',
  }));
  const delayedApproval = firstService.adminProcessWithdrawal(raceRequest.id, { action:'approve', txHash:raceHash });
  await firstService.adminProcessWithdrawal(raceRequest.id, { action:'reject', reason:'并发风控拒绝' });
  releaseRace();
  await assert.rejects(delayedApproval, /已经处理过/);
  assert.equal(firstService.balanceUnits(wallet.address), 10_000_000n, '并发审核不能在退款后覆盖状态');

  // 冻结指定账户 USDT 提现：冻结期间新申请被拒，状态随账本持久化，解冻后恢复
  firstService.adminSetWithdrawalFreeze(wallet.address, { frozen: true, reason: '风控测试', operator: 'admin' });
  await assert.rejects(
    async () => firstService.requestWithdrawal(wallet.address, await signedWithdrawalBody(wallet, {
      asset:'USDT', amount:'10', address:wallet.address, network:'base', requestId:'withdraw_test_freeze_1',
    })),
    /提现已冻结/,
  );
  assert.equal(firstService.adminListWithdrawalFrozen().length, 1, '冻结名单应包含该账户');
  const frozenService = createWalletService({ dataRoot, networks:[] });
  assert.equal(frozenService.adminGetWithdrawalFreeze(wallet.address)?.reason, '风控测试', '冻结状态应随账本持久化');
  firstService.adminSetWithdrawalFreeze(wallet.address, { frozen: false });
  const unfrozenRequest = firstService.requestWithdrawal(wallet.address, await signedWithdrawalBody(wallet, {
    asset:'USDT', amount:'10', address:wallet.address, network:'base', requestId:'withdraw_test_freeze_2',
  }));
  assert.equal(unfrozenRequest.address, wallet.address, '解冻后应可正常发起提现');
  const unfrozenClean = await firstService.adminProcessWithdrawal(unfrozenRequest.id, { action:'reject', reason:'清理' });
  assert.equal(unfrozenClean.status, 'rejected');
  assert.equal(firstService.balanceUnits(wallet.address), 10_000_000n, '冻结用例清理后余额复原');

  const restartedService = createWalletService({ dataRoot, networks:[] });
  assert.equal(
    restartedService.getSession(login.token)?.address,
    wallet.address,
    '平台重启后钱包会话应继续有效',
  );

  const persisted = restartedService.database.loadWalletState();
  assert.equal(JSON.stringify(persisted).includes(login.token), false, '磁盘中不能保存原始会话令牌');

  restartedService.logout(login.token);
  assert.equal(createWalletService({ dataRoot, networks:[] }).getSession(login.token), null);
  console.log('wallet-session tests passed');
} finally {
  closeDatabase(dataRoot);
  fs.rmSync(dataRoot, { recursive:true, force:true });
}
