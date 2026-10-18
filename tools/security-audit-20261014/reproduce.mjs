// Local-only reproduction. Random keys and in-memory balances; no RPC or real data.
import assert from 'node:assert/strict';
import { Wallet, solidityPackedKeccak256, recoverAddress, hashMessage, getBytes, parseUnits } from '../../resources/app/node_modules/ethers/lib.esm/index.js';
import { createATokenClaimService } from '../../resources/app/src/a-token-claim-service.js';

const signer = Wallet.createRandom();
const user = Wallet.createRandom();
const contract = Wallet.createRandom().address;
function fixture({ failInsert = false } = {}) {
  let balance = parseUnits('1000', 18);
  const rows = new Map();
  const service = createATokenClaimService({
    aTokenService: {
      balanceA: () => balance,
      debitA: (_wallet, units) => { balance -= BigInt(units); },
      creditA: (_wallet, units) => { balance += BigInt(units); },
    },
    database: {
      sumATokenClaimsByWalletToday: () => 0n,
      upsertATokenClaimRow: row => { if (failInsert) throw new Error('simulated insert failure'); rows.set(row.id, { ...row }); },
      getATokenClaimById: id => rows.get(id),
      listPendingATokenClaims: () => [...rows.values()].filter(row => row.status === 'pending'),
    },
    contractAddress: contract,
    signerPrivateKey: signer.privateKey,
    staleTimeoutMs: -1,
  });
  return { service, rows, balance: () => balance };
}

const f = fixture();
const claim = f.service.signClaim({ wallet: user.address, amount: 100 });
const digest = solidityPackedKeccak256(['address', 'uint256', 'uint256', 'address'],
  [user.address, claim.amountUnits, BigInt('0x' + claim.nonce), contract]);
assert.equal(recoverAddress(digest, claim.signature), signer.address);
assert.notEqual(recoverAddress(hashMessage(getBytes(digest)), claim.signature), signer.address);
console.log('CONFIRMED: issued signature fails the EIP-191 verification used by AIXPool.harvest.');

assert.equal(f.balance(), parseUnits('900', 18));
assert.equal(f.service.sweepStaleClaims().refunded, 1);
assert.equal(f.balance(), parseUnits('1000', 18));
assert.equal(recoverAddress(digest, claim.signature), signer.address);
console.log('CONFIRMED: expiry refunds the ledger without RPC checks or revoking the issued authorization.');
// Model only the obvious EIP-191 repair; demonstrates why fixing signing alone is unsafe.
const repairedSignature = await signer.signMessage(getBytes(digest));
assert.equal(recoverAddress(hashMessage(getBytes(digest)), repairedSignature), signer.address);
console.log('CONDITIONAL: after the signing repair, a refunded unused authorization still passes contract signature verification; harvest has no deadline or revocation check.');

const broken = fixture({ failInsert: true });
assert.throws(() => broken.service.signClaim({ wallet: user.address, amount: 100 }), /simulated insert failure/);
assert.equal(broken.balance(), parseUnits('900', 18));
assert.equal(broken.rows.size, 0);
console.log('CONFIRMED: claim persistence failure leaves a debit without a claim record.');
