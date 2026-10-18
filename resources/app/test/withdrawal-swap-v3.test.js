import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Interface, Wallet } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { createWithdrawalPayoutService } from '../src/withdrawal-payout-service.js';
import { closeDatabase } from '../src/database.js';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-withdrawal-v3-test-'));
const signerWallet = Wallet.createRandom();
const userWallet = Wallet.createRandom();

// 提现必须由用户钱包 personal_sign 签名（消息格式与 wallet-service.verifyOperationSignature 一致）
const signedWithdrawalBody = async (user, body) => {
  const timestamp = String(Date.now());
  const message = `AxiX 提现确认：${body.amount} ${body.asset ?? 'USDT'}，编号 ${body.requestId}，时间：${timestamp}`;
  return { ...body, timestamp, signature: await user.signMessage(message) };
};

const USDT = '0x55d398326f99059fF775485246999027B3197955';
const USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
const ROUTER = '0x1b81D678ffb9C0263b24A97847620C99d213eB14';
const QUOTER = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';

const erc20 = new Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const quoterIface = new Interface([
  'function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
]);
const routerIface = new Interface([
  'function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn)',
]);

let broadcastCount = 0;
let sentTransactions = [];
let usdcBalance = 1000n * 10n ** 18n;
let quoterFails = false;

const provider = {
  async call({ to, data }) {
    const target = String(to).toLowerCase();
    if (target === USDC.toLowerCase()) {
      const selector = data.slice(0, 10);
      if (selector === erc20.getFunction('balanceOf').selector) {
        return erc20.encodeFunctionResult('balanceOf', [usdcBalance]);
      }
      if (selector === erc20.getFunction('allowance').selector) {
        return erc20.encodeFunctionResult('allowance', [0n]);
      }
    }
    if (target === QUOTER.toLowerCase()) {
      if (quoterFails) throw new Error('no liquidity');
      const [params] = quoterIface.decodeFunctionData('quoteExactOutputSingle', data);
      // 0.01% 池比 0.05% 池便宜，验证服务选择了最优费率档
      const ratePer10k = Number(params.fee) === 100 ? 9997n : 10002n;
      const amountIn = BigInt(params.amount) * ratePer10k / 10000n;
      return quoterIface.encodeFunctionResult('quoteExactOutputSingle', [amountIn, 0n, 0n, 0n]);
    }
    throw new Error(`unexpected eth_call to ${to}`);
  },
  async broadcastTransaction() { broadcastCount += 1; return {}; },
  async getTransaction() { return broadcastCount ? {} : null; },
  async getTransactionReceipt() { return { status:1, blockNumber:100 }; },
  async getBlockNumber() { return 110; },
  async waitForTransaction() { return { status:1, blockNumber:100 }; },
};

let nextNonce = 1;
const signer = {
  address:signerWallet.address,
  async populateTransaction(transaction) { return { ...transaction, nonce:nextNonce++ }; },
  async signTransaction(transaction) {
    sentTransactions.push(transaction);
    return `0x${Number(transaction.nonce).toString(16).padStart(4, '0')}`;
  },
};
const network = {
  id:'bsc', name:'BNB Smart Chain', chainId:56, provider, signer,
  rpcUrl:'', tokenContract:USDT, tokenDecimals:18, confirmations:1,
};
const swap = {
  enabled:true,
  usdcContract:USDC,
  v3Router:ROUTER,
  v3Quoter:QUOTER,
  v3FeeTiers:[100, 500],
  slippageBps:30,
};

try {
  const walletService = createWalletService({
    dataRoot,
    withdrawalAddress:signerWallet.address,
    autoWithdrawalEnabled:true,
    autoWithdrawalReviewThresholdUsdt:'9999',
    autoWithdrawalDailyLimitUsdt:'99999',
    networks:[network],
  });
  walletService.creditBalance(userWallet.address, 'USDT', 100_000000n);

  const payoutService = createWithdrawalPayoutService({
    walletService,
    networks:[network],
    withdrawalAddress:signerWallet.address,
    privateKey:signerWallet.privateKey,
    enabled:true,
    isEnabled:() => walletService.withdrawalAutomationSettings().enabled,
    swap,
  });

  const status = payoutService.status().swap;
  assert.equal(status.enabled, true);
  assert.equal(status.provider, 'pancake-v3');
  assert.deepEqual(status.feeTiers, [100, 500]);

  const request = walletService.requestWithdrawal(userWallet.address, await signedWithdrawalBody(userWallet, {
    asset:'USDT', network:'bsc', amount:'10', requestId:'v3_swap_0001',
  }));
  await payoutService.enqueue(request.id);

  const record = walletService.payoutRecord(request.id);
  assert.equal(record.status, 'paid');
  assert.equal(broadcastCount, 2, '应广播授权 + 兑换两笔交易');
  assert.match(String(record.routeTool || ''), /^pancake-v3:f100$/, '应记录 0.01% 池路由');

  const approveTx = sentTransactions[0];
  const swapTx = sentTransactions[1];

  // 授权交易：授权对象必须是 V3 Router，额度不超过滑点上限
  assert.equal(approveTx.to.toLowerCase(), USDC.toLowerCase());
  const approveArgs = erc20.decodeFunctionData('approve', approveTx.data);
  assert.equal(approveArgs[0].toLowerCase(), ROUTER.toLowerCase());
  const approvedMax = BigInt(approveArgs[1]);

  // 兑换交易：走 V3 Router，recipient 直接是用户，USDT 足额
  assert.equal(swapTx.to.toLowerCase(), ROUTER.toLowerCase());
  const [swapArgs] = routerIface.decodeFunctionData('exactOutputSingle', swapTx.data);
  assert.equal(swapArgs.tokenIn.toLowerCase(), USDC.toLowerCase());
  assert.equal(swapArgs.tokenOut.toLowerCase(), USDT.toLowerCase());
  assert.equal(Number(swapArgs.fee), 100);
  assert.equal(swapArgs.recipient.toLowerCase(), userWallet.address.toLowerCase());
  assert.equal(BigInt(swapArgs.amountOut), 10n ** 19n, '用户必须收到足额 10 USDT');
  assert.equal(BigInt(swapArgs.amountInMaximum), approvedMax, '授权额度与交易上限一致');
  assert.ok(swapArgs.deadline > Math.floor(Date.now() / 1000), 'deadline 必须是未来时间');
  // 10 USDT 在 0.01% 池报价 9.997 USDC，0.3% 滑点上限约 10.027
  assert.ok(BigInt(swapArgs.amountInMaximum) > 10n ** 19n);
  assert.ok(BigInt(swapArgs.amountInMaximum) < 101n * 10n ** 17n);

  // 场景二：USDC 余额不足 → 挂起待人工补币放行，且不广播任何交易
  broadcastCount = 0;
  sentTransactions = [];
  usdcBalance = 1n * 10n ** 18n;
  const poor = walletService.requestWithdrawal(userWallet.address, await signedWithdrawalBody(userWallet, {
    asset:'USDT', network:'bsc', amount:'10', requestId:'v3_swap_poor_0001',
  }));
  await payoutService.enqueue(poor.id);
  assert.equal(walletService.payoutRecord(poor.id).status, 'pending_funds');
  assert.equal(broadcastCount, 0, '余额不足时不得广播授权或兑换交易');

  // 场景三：所有费率池都无流动性 → 报价失败属于瞬时问题，进入自动重试队列（不退款）
  broadcastCount = 0;
  usdcBalance = 1000n * 10n ** 18n;
  quoterFails = true;
  const noLiq = walletService.requestWithdrawal(userWallet.address, await signedWithdrawalBody(userWallet, {
    asset:'USDT', network:'bsc', amount:'10', requestId:'v3_swap_noliq_0001',
  }));
  await payoutService.enqueue(noLiq.id);
  assert.equal(walletService.payoutRecord(noLiq.id).status, 'pending_auto');
  assert.equal(broadcastCount, 0);

  // 配置校验：开启闪兑但合约地址非法时拒绝启动
  assert.throws(() => createWithdrawalPayoutService({
    walletService,
    networks:[network],
    withdrawalAddress:signerWallet.address,
    privateKey:signerWallet.privateKey,
    enabled:true,
    swap:{ ...swap, v3Router:'not-an-address' },
  }), /V3 路由\/报价合约地址配置无效/);

  console.log('withdrawal pancake-v3 swap tests passed');
} finally {
  closeDatabase(dataRoot);
  fs.rmSync(dataRoot, { recursive:true, force:true });
}
