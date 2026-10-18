// 一次性补发：链上已付款但站内从未提交激活的漏单（人工核实链上交易后执行）
// 用法：node scripts/fix-missing-miner-20261009.mjs
import { getConfig, DATA_ROOT } from '../src/config.js';
import { createWalletService } from '../src/wallet-service.js';
import { createATokenService } from '../src/a-token-service.js';
import { createATokenTeamService } from '../src/a-token-team-service.js';
import { createATokenMinerService } from '../src/a-token-miner-service.js';
import { createATokenActivationService } from '../src/a-token-activation-service.js';
import { createReferralService } from '../src/referral-service.js';
import { createLotteryService } from '../src/lottery-service.js';

const WALLET = '0x03e4b9f93f300901191b0aeff7368021f3f254f4';
const TX_HASH = '0x5db568ccbad770040224ec7fffbfbcd25b991fa6233bdc10005545611d03296e';
const BLOCK_NUMBER = 126614387;
const TX_TIME = Date.parse('2026-10-09T09:47:29.000Z'); // 链上出块时刻

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

// ── 安全检查（任何一项命中即中止，不做任何写入） ──
if (db.listATokenMiners(wl).some(m => m.plan === 'mini120')) throw new Error('ABORT: 已存在 mini120 矿机');
if (db.listATokenMiners(wl).some(m => m.plan === 'pro1500')) throw new Error('ABORT: 已存在 pro1500 矿机');
if (db.getATokenActivationByTx(TX_HASH)) throw new Error('ABORT: 该 txHash 已提交过激活');
if (db.countATokenActivationsByWalletPlan(WALLET, '1') > 0) throw new Error('ABORT: 该钱包已有 plan1 激活记录');

const now = Date.now();
const record = {
  id: `ata_1_${now}_${wl.slice(0, 8)}`,
  wallet: WALLET, plan: '1',
  bnbAmountWei: (2n * 10n ** 15n).toString(),
  txHash: TX_HASH, blockNumber: BLOCK_NUMBER,
  status: 'pending', confirmedAt: null,
  createdAt: TX_TIME, // createdAt 用真实付款时刻
  payload: {
    plan: '1', bnb: '0.002', minerPlan: 'mini120', wallet: WALLET,
    manualFix: '20261009 线下核验补单: 链上 0.002 BNB → 收款地址 status=1 confirmations=7718, 站内从未提交(前端漏单)',
  },
};

console.log('[1] 写入 pending 激活记录:', record.id);
db.upsertATokenActivationRow(record);

console.log('[2] 走 confirm() 汇聚点（与自动确认/后台确认完全一致）...');
const confirmed = activationService.confirm(record);

console.log('[3] 结果核验:');
const miners = db.listATokenMiners(wl);
console.log('  激活记录:', confirmed.status, 'confirmedAt =', confirmed.confirmedAt);
console.log('  矿机:', JSON.stringify(miners.map(m => ({ id: m.id, plan: m.plan, status: m.status, startedAt: m.startedAt, expiresAt: m.expiresAt }))));
try {
  const flows = lotteryService.listFlows(WALLET, 10);
  console.log('  积分流水:', JSON.stringify(flows.map(f => ({ change: f.change, type: f.type, refId: f.refId }))));
} catch (e) { console.log('  积分流水查询失败:', e.message); }
console.log('[done] 补发完成');
process.exit(0);
