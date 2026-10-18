import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Interface, Wallet } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { closeDatabase } from '../src/database.js';

const transfer = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-wallet-deposit-test-'));
const depositAddress = '0x00000000000000000000000000000000000000D0';
const tokenContract = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const wallet = Wallet.createRandom();
const otherWallet = Wallet.createRandom();
const ledgerAmountUnits = 30_000000n;
const amountUnits = ledgerAmountUnits * 1_000_000_000_000n;
const txHash = `0x${'1'.repeat(64)}`;
const forcedHash = `0x${'2'.repeat(64)}`;   // 客户端声明 asset=BTC 的那笔（链上其实是 USDT 转账）
const lowHash = `0x${'3'.repeat(64)}`;      // 链上 9 USDT：低于最低充值 10 USDT
const fracHash = `0x${'4'.repeat(64)}`;     // 链上 10.5 USDT：非整数金额
const elevenHash = `0x${'5'.repeat(64)}`;   // 链上 11 USDT：不是 10 的整数倍
// 各交易哈希对应的链上金额（USDT 按 18 位小数）
const chainUnitsByHash = new Map([
  [txHash, amountUnits],
  [forcedHash, amountUnits],
  [lowHash, 9n * 1_000_000_000_000_000_000n],
  [fracHash, 10n * 1_000_000_000_000_000_000n + 500_000_000_000_000_000n],
  [elevenHash, 11n * 1_000_000_000_000_000_000n],
]);
const transferDataFor = amount => transfer.encodeFunctionData('transfer', [depositAddress, amount]);
const transferLogFor = amount => transfer.encodeEventLog(transfer.getEvent('Transfer'), [wallet.address, depositAddress, amount]);
const provider = {
  async getTransaction(hash) {
    const amount = chainUnitsByHash.get(hash);
    if (amount === undefined) return null;
    return { hash, chainId:56n, from:wallet.address, to:tokenContract, data:transferDataFor(amount) };
  },
  async getTransactionReceipt(hash) {
    const amount = chainUnitsByHash.get(hash);
    if (amount === undefined) return null;
    const log = transferLogFor(amount);
    return { status:1, blockNumber:100, logs:[{ address:tokenContract, topics:log.topics, data:log.data }] };
  },
  async getBlockNumber() { return 110; },
};
const network = { id:'bsc', name:'BNB Smart Chain', chainId:56, provider, rpcUrl:'', tokenContract, tokenDecimals:18, confirmations:10 };

try {
  const service = createWalletService({ dataRoot, depositAddress, networks:[network] });
  const confirmed = await service.submitDeposit(wallet.address, { network:'bsc', asset:'USDT', txHash });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.amount, '30.0');
  assert.equal(service.balanceUnits(wallet.address), ledgerAmountUnits);
  const admin = service.adminDashboard();
  assert.equal(admin.summary.walletUsers, 1);
  assert.equal(admin.summary.realUsers, 1);
  assert.equal(admin.summary.confirmedDeposits, 1);
  assert.equal(admin.summary.totalDepositedUsdt, '30.0');
  assert.equal(admin.users[0].isRealUser, true);

  const replay = await service.submitDeposit(wallet.address, { network:'bsc', asset:'USDT', txHash });
  assert.equal(replay.id, confirmed.id);
  assert.equal(service.balanceUnits(wallet.address), ledgerAmountUnits, '重复交易哈希不能重复入账');
  await assert.rejects(
    service.submitDeposit(otherWallet.address, { network:'bsc', asset:'USDT', txHash }),
    /已被其他账户提交/,
  );

  // 充值资产必须强制为网络代币：即使客户端声明 asset=BTC，链上是一笔 USDT 转账，
  // 也必须按 USDT 入账，绝不能记成 BTC（否则 0.1 USDT 会被放大成 0.001 BTC）。
  const forced = await service.submitDeposit(wallet.address, { network:'bsc', asset:'BTC', txHash:forcedHash });
  assert.equal(forced.status, 'confirmed');
  assert.equal(forced.asset, 'USDT', '充值资产必须强制为 USDT，不能信任客户端传入的 asset');
  assert.equal(service.balanceUnits(wallet.address, 'BTC'), 0n, '不得把 USDT 转账记成 BTC');
  assert.equal(service.balanceUnits(wallet.address), ledgerAmountUnits * 2n);

  // 最低 10 USDT：链上仅 9 USDT 必须被拒
  const low = await service.submitDeposit(wallet.address, { network:'bsc', asset:'USDT', txHash:lowHash });
  assert.equal(low.status, 'rejected', '低于最低充值金额应被拒');
  // 必须为整数：链上 10.5 USDT 必须被拒
  const frac = await service.submitDeposit(wallet.address, { network:'bsc', asset:'USDT', txHash:fracHash });
  assert.equal(frac.status, 'rejected', '非整数充值金额应被拒');
  // 必须为 10 的整数倍：链上 11 USDT 必须被拒
  const eleven = await service.submitDeposit(wallet.address, { network:'bsc', asset:'USDT', txHash:elevenHash });
  assert.equal(eleven.status, 'rejected', '非 10 的整数倍充值应被拒');
  assert.match(eleven.reason, /10 的整数倍/);
  assert.equal(service.balanceUnits(wallet.address), ledgerAmountUnits * 2n, '被拒的充值不得入账');

  for (let index = 2; index <= 11; index += 1) {
    await service.submitDeposit(wallet.address, { network:'bsc', asset:'USDT', txHash:`0x${index.toString(16).padStart(64, '0')}` });
  }
  await assert.rejects(
    service.submitDeposit(wallet.address, { network:'bsc', asset:'USDT', txHash:`0x${'f'.repeat(64)}` }),
    /最多只能同时核验 10 笔充值/,
  );
  assert.equal(service.balanceUnits(wallet.address), ledgerAmountUnits * 2n, '未查到的交易不能入账');
  console.log('wallet-deposit tests passed');
} finally {
  closeDatabase(dataRoot);
  fs.rmSync(dataRoot, { recursive:true, force:true });
}
