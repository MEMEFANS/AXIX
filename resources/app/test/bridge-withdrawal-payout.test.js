import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Interface, Wallet } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { createWithdrawalPayoutService } from '../src/withdrawal-payout-service.js';
import { closeDatabase } from '../src/database.js';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-bridge-payout-test-'));
const treasury = Wallet.createRandom();
const user = Wallet.createRandom();

// 提现必须由用户钱包 personal_sign 签名（消息格式与 wallet-service.verifyOperationSignature 一致）
const signedWithdrawalBody = async (userWallet, body) => {
  const timestamp = String(Date.now());
  const message = `AxiX 提现确认：${body.amount} ${body.asset ?? 'USDT'}，编号 ${body.requestId}，时间：${timestamp}`;
  return { ...body, timestamp, signature: await userWallet.signMessage(message) };
};
const router = Wallet.createRandom().address;
const arbitrumToken = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const bscToken = '0x55d398326f99059fF775485246999027B3197955';
const destinationHash = `0x${'9'.repeat(64)}`;
const token = new Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
let nonce = 1;
let sourceHash = '';
const sourceProvider = {
  async call({ data }) {
    if (String(data).startsWith('0x70a08231')) return token.encodeFunctionResult('balanceOf', [1_000_000000n]);
    return token.encodeFunctionResult('allowance', [1_000_000000n]);
  },
  async broadcastTransaction(raw) { sourceHash = `0x${String(raw).slice(2).padStart(64, '0')}`; return { hash:sourceHash }; },
  async getTransaction() { return {}; },
  async getTransactionReceipt(hash) { return hash ? { status:1, blockNumber:100 } : null; },
  async getBlockNumber() { return 120; },
};
const signer = {
  address:treasury.address,
  async populateTransaction(transaction) { return { ...transaction, nonce:nonce++ }; },
  async signTransaction(transaction) { return `0x${Number(transaction.nonce).toString(16).padStart(4, '0')}`; },
};
const received = 10n * 10n ** 18n;
const event = token.encodeEventLog(token.getEvent('Transfer'), [router, user.address, received]);
const targetProvider = {
  async getTransactionReceipt(hash) { return hash === destinationHash ? { status:1, blockNumber:200, logs:[{ address:bscToken, topics:event.topics, data:event.data }] } : null; },
  async getBlockNumber() { return 220; },
};
const networks = [
  { id:'arbitrum', chainId:42161, provider:sourceProvider, signer, tokenContract:arbitrumToken, tokenDecimals:6, confirmations:10 },
  { id:'bsc', chainId:56, provider:targetProvider, tokenContract:bscToken, tokenDecimals:18, confirmations:10 },
];
const bridgeService = {
  enabled:true,
  settlementNetwork:'arbitrum',
  async withdrawalQuote() {
    return { tool:'across', fromAmount:'10.1', approvalAddress:router, transactionRequest:{ to:router, data:'0x1234', value:'0x0', chainId:42161 } };
  },
  async status() {
    return { status:'DONE', receiving:{ chainId:56, txHash:destinationHash, token:{ address:bscToken } } };
  },
};

try {
  const walletService = createWalletService({
    dataRoot, withdrawalAddress:treasury.address, autoWithdrawalEnabled:true,
    autoWithdrawalReviewThresholdUsdt:'100', autoWithdrawalDailyLimitUsdt:'100', networks,
  });
  walletService.creditBalance(user.address, 'USDT', 20_000000n);
  const withdrawal = walletService.requestWithdrawal(user.address, await signedWithdrawalBody(user, {
    asset:'USDT', network:'bsc', amount:'10', requestId:'bridge_withdrawal_0001',
  }));
  const payout = createWithdrawalPayoutService({
    walletService, networks, withdrawalAddress:treasury.address, privateKey:treasury.privateKey,
    enabled:true, bridgeService,
  });
  await payout.enqueue(withdrawal.id);
  const record = walletService.payoutRecord(withdrawal.id);
  assert.equal(record.status, 'paid');
  assert.equal(record.routeTool, 'across');
  assert.equal(record.sourceNetwork, 'arbitrum');
  assert.equal(record.destinationTxHash, destinationHash);
  assert.equal(walletService.balanceUnits(user.address), 10_000000n);
  console.log('bridge-withdrawal-payout tests passed');
} finally {
  closeDatabase(dataRoot);
  fs.rmSync(dataRoot, { recursive:true, force:true });
}
