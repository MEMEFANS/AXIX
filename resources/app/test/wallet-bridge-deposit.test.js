import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Interface, Wallet } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { closeDatabase } from '../src/database.js';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-wallet-bridge-test-'));
const user = Wallet.createRandom();
const treasury = '0x00000000000000000000000000000000000000D0';
const sourceToken = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const targetToken = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const sourceHash = `0x${'1'.repeat(64)}`;
const destinationHash = `0x${'2'.repeat(64)}`;
const transfer = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const event = transfer.encodeEventLog(transfer.getEvent('Transfer'), [Wallet.createRandom().address, treasury, 99_500000n]);
const sourceProvider = {
  async getTransaction() { return { chainId:1n, from:user.address, to:Wallet.createRandom().address }; },
  async getTransactionReceipt() { return { status:1, blockNumber:100, logs:[] }; },
  async getBlockNumber() { return 110; },
};
const targetProvider = {
  async getTransactionReceipt(hash) { return hash === destinationHash ? { status:1, blockNumber:200, logs:[{ address:targetToken, topics:event.topics, data:event.data }] } : null; },
  async getBlockNumber() { return 220; },
};
const bridgeService = {
  enabled:true,
  settlementNetwork:'arbitrum',
  minimumReceivedBps:9900,
  publicConfig() { return { enabled:true, settlementNetwork:'arbitrum' }; },
  async status() {
    return {
      status:'DONE',
      sending:{ chainId:1, txHash:sourceHash, amount:'100000000', token:{ address:sourceToken } },
      receiving:{ chainId:42161, txHash:destinationHash, token:{ address:targetToken } },
    };
  },
};

try {
  const service = createWalletService({
    dataRoot, depositAddress:treasury, bridgeService,
    networks:[
      { id:'ethereum', name:'Ethereum', chainId:1, provider:sourceProvider, tokenContract:sourceToken, tokenDecimals:6, confirmations:2, explorerUrl:'https://etherscan.io' },
      { id:'arbitrum', name:'Arbitrum', chainId:42161, provider:targetProvider, tokenContract:targetToken, tokenDecimals:6, confirmations:10, explorerUrl:'https://arbiscan.io' },
    ],
  });
  const result = await service.submitDeposit(user.address, { network:'ethereum', asset:'USDT', txHash:sourceHash, routeTool:'across' });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.amount, '100.0');
  assert.equal(result.destinationTxHash, destinationHash);
  assert.equal(service.balanceUnits(user.address), 100_000000n);
  console.log('wallet-bridge-deposit tests passed');
} finally {
  closeDatabase(dataRoot);
  fs.rmSync(dataRoot, { recursive:true, force:true });
}
