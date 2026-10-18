// One-off backfill: on-chain 0.05 BNB paid but never submitted for activation.
// Wallet : 0x8B2a642A6b658532044B08F60fA4E117700b0D79
// Tx     : 0x1fbc2575385fa1975fa6c8165c2796c32d7b29b6dd84d50bad71c6a7f66b7000
// Chain  : status=success, to=main collection 0xa71e0cfb...56e6, value=0.05 BNB,
//          block 127531720, time 2026-10-14 12:35:52 (Beijing) / 04:35:52Z.
// Note   : the pro1500 miner was already granted manually via funds-admin at
//          13:54:18, so confirm() will NOT create a second miner; this script only
//          writes the formal activation record and awards the activation points
//          (self_activate_plan2=300 to the wallet, direct_activate_plan2=150 to referrer).
// Usage  : cd /opt/wg-platform && node scripts/fix-missing-miner-pro-8b2a-20261014.mjs
import { getConfig, DATA_ROOT } from '../src/config.js';
import { createWalletService } from '../src/wallet-service.js';
import { createATokenService } from '../src/a-token-service.js';
import { createATokenTeamService } from '../src/a-token-team-service.js';
import { createATokenMinerService } from '../src/a-token-miner-service.js';
import { createATokenActivationService } from '../src/a-token-activation-service.js';
import { createReferralService } from '../src/referral-service.js';
import { createLotteryService } from '../src/lottery-service.js';

const WALLET = '0x8B2a642A6b658532044B08F60fA4E117700b0D79';
const TX_HASH = '0x1fbc2575385fa1975fa6c8165c2796c32d7b29b6dd84d50bad71c6a7f66b7000';
const BLOCK_NUMBER = 127531720;
const TX_TIME = Date.parse('2026-10-14T04:35:52.000Z'); // on-chain block time (UTC)

const cfg = getConfig();
const walletService = createWalletService({ ...cfg.wallet, dataRoot: DATA_ROOT, withdrawalPrivateKey: cfg.wallet.withdrawalPrivateKey });
const db = walletService.database;
const aTokenService = createATokenService({ database: db, walletService });
const teamService = createATokenTeamService({ database: db, walletService });
const minerService = createATokenMinerService({ aTokenService, database: db, teamService });
const referralService = createReferralService({ database: db, walletService });
const lotteryService = createLotteryService({ database: db, walletService, referralService });
const activationService = createATokenActivationService({
  aTokenService, minerService, database: db,
  onConfirmed: (w, p) => lotteryService.onMinerActivated(w, p),
});

const wl = WALLET.toLowerCase();

// -- Safety checks: abort before any write if the case does not match --
if (db.getATokenActivationByTx(TX_HASH)) throw new Error('ABORT: this txHash already submitted');
if (db.countATokenActivationsByWalletPlan(WALLET, '2') > 0) throw new Error('ABORT: wallet already has a plan2 activation record');
const minerBefore = db.listATokenMiners(wl).filter(m => m.plan === 'pro1500');
console.log('[0] pro1500 miner already present:', minerBefore.length, '(confirm() will not create another)');

const now = Date.now();
const record = {
  id: `ata_2_${now}_${wl.slice(0, 8)}`,
  wallet: WALLET, plan: '2',
  bnbAmountWei: (5n * 10n ** 16n).toString(),
  txHash: TX_HASH, blockNumber: BLOCK_NUMBER,
  status: 'pending', confirmedAt: null,
  createdAt: TX_TIME, // createdAt uses the real on-chain payment time
  payload: {
    plan: '2', bnb: '0.05', minerPlan: 'pro1500', wallet: WALLET,
    manualFix: '20261014 backfill: on-chain 0.05 BNB to main collection (status=success, block 127531720), never submitted in-app; miner granted by funds-admin first, record backfilled here',
  },
};

console.log('[1] write pending activation record:', record.id);
db.upsertATokenActivationRow(record);

console.log('[2] go through confirm() (same convergence point as auto-verify)...');
const confirmed = activationService.confirm(record);

console.log('[3] verify result:');
console.log('  activation:', confirmed.status, 'confirmedAt =', confirmed.confirmedAt);
const miners = db.listATokenMiners(wl);
console.log('  miners:', JSON.stringify(miners.map(m => ({ id: m.id, plan: m.plan, status: m.status, startedAt: m.startedAt }))));
try {
  const flows = lotteryService.listFlows(WALLET, 10);
  console.log('  points flows:', JSON.stringify(flows.map(f => ({ change: f.change, type: f.type, refId: f.refId }))));
} catch (e) { console.log('  points flow query failed:', e.message); }
console.log('[done]');
process.exit(0);
