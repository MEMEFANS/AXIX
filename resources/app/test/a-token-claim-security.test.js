import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet, parseUnits, solidityPackedKeccak256, hashMessage, getBytes, recoverAddress, Interface } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { createATokenClaimService } from '../src/a-token-claim-service.js';
import { closeDatabase } from '../src/database.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-security-'));
const signer = Wallet.createRandom(), user = Wallet.createRandom(), contract = Wallet.createRandom().address;
const walletService = createWalletService({ dataRoot: root, networks: [] });
const database = walletService.database;
walletService.creditBalance(user.address, 'A', parseUnits('1000000', 18));
const abi = new Interface(['function isClaimUsed(address,uint256,uint256) view returns (bool)', 'event Harvested(address indexed user,uint256 amount,uint256 nonce,uint256 newReserve)']);
let receipt;
const provider = {
  getNetwork: async () => ({ chainId: 56n }),
  getTransactionReceipt: async () => receipt,
  getBlockNumber: async () => 120,
  call: async () => abi.encodeFunctionResult('isClaimUsed', [true]),
};
const service = createATokenClaimService({
  walletService, database, provider, contractAddress: contract, signerPrivateKey: signer.privateKey,
  staleTimeoutMs: -1,
  aTokenService: {
    balanceA: address => walletService.balanceUnits(address, 'A'),
    debitA: (address, units) => walletService.debitBalance(address, 'A', units),
  },
});
try {
  const claim = service.signClaim({ wallet: user.address, amount: '100.000000000000000001' });
  assert.equal(claim.amountUnits, parseUnits('100.000000000000000001', 18).toString());
  const digest = solidityPackedKeccak256(['address','uint256','uint256','address'], [user.address, claim.amountUnits, BigInt('0x'+claim.nonce), contract]);
  assert.equal(recoverAddress(hashMessage(getBytes(digest)), claim.signature), signer.address);
  const balance = walletService.balanceUnits(user.address, 'A');
  assert.equal(service.sweepStaleClaims().refunded, 0);
  assert.throws(() => service.refundClaim(claim.claimId), /禁止退款/);
  assert.equal(walletService.balanceUnits(user.address, 'A'), balance);
  assert.equal(service.dailyClaimed(user.address), BigInt(claim.amountUnits));

  const original = database.upsertATokenClaimRow;
  database.upsertATokenClaimRow = () => { throw new Error('injected persistence failure'); };
  assert.throws(() => service.signClaim({ wallet: user.address, amount: '100' }), /injected/);
  database.upsertATokenClaimRow = original;
  assert.equal(walletService.balanceUnits(user.address, 'A'), balance);
  assert.equal(BigInt(database.loadWalletState().users[user.address.toLowerCase()].balances.A), balance);
  assert.equal(service.listClaims(user.address).length, 1);

  const txHash = '0x'+'a'.repeat(64);
  await assert.rejects(service.confirmClaim({ wallet: user.address, claimId: claim.claimId, txHash }), /尚未成功/);
  receipt = { status: 1, to: contract, blockNumber: 100, logs: [] };
  await assert.rejects(service.confirmClaim({ wallet: user.address, claimId: claim.claimId, txHash }), /不匹配/);
  const event = abi.encodeEventLog(abi.getEvent('Harvested'), [user.address, claim.amountUnits, BigInt('0x'+claim.nonce), 0]);
  receipt.logs = [{ address: contract, ...event }];
  receipt.blockNumber = 119;
  await assert.rejects(service.confirmClaim({ wallet: user.address, claimId: claim.claimId, txHash }), /确认数不足/);
  receipt.blockNumber = 100;
  assert.equal((await service.confirmClaim({ wallet: user.address, claimId: claim.claimId, txHash })).status, 'confirmed');
  console.log('PASS: EIP-191 compatibility, exact units, fail-closed refunds, atomic rollback, exact daily sum, on-chain confirmation');
} finally {
  closeDatabase(root);
  fs.rmSync(root, { recursive: true, force: true });
}
