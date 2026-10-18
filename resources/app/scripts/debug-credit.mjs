import { Interface, Wallet } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-debug4-'));
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
const network = { id:'base', name:'Base', chainId:8453, provider, rpcUrl:'', tokenContract, confirmations:10 };
const svc = createWalletService({ dataRoot, withdrawalAddress:sender, networks:[network] });
svc.creditBalance(wallet.address, 'USDT', 20_000_000n);
const w = svc.requestWithdrawal(wallet.address, { asset:'USDT', amount:'10', address:wallet.address, network:'base', requestId:'withdraw_test_0001' });
console.log('amountUnits:', w.amountUnits, '| amount:', w.amount);
try { await svc.adminProcessWithdrawal(w.id, { action:'approve', txHash:wrongHash }); console.log('wrong OK?!'); }
catch (e) { console.log('wrong rejected:', e.message); }
try { const paid = await svc.adminProcessWithdrawal(w.id, { action:'approve', txHash:paidHash }); console.log('paid OK:', paid.status); }
catch (e) { console.log('paid FAIL:', e.message); }
releaseRace();
try { fs.rmSync(dataRoot, { recursive:true, force:true }); } catch {}
