// 只读诊断（snapshot 为业务正常重算，页面打开时同样会执行）：团队等级构成
import { formatUnits } from 'ethers';
import { getConfig, DATA_ROOT } from './src/config.js';
import { createBridgeService } from './src/bridge-service.js';
import { createWalletService } from './src/wallet-service.js';
import { createATokenTeamService } from './src/a-token-team-service.js';
import { splitStakePayment } from './src/a-token-income.js';

const wallet = String(process.argv[2] || '').toLowerCase();
if (!wallet) { console.error('usage: node team-level-diag.mjs <wallet>'); process.exit(1); }

const cfg = getConfig();
const bridgeService = createBridgeService({ ...cfg.wallet.bridge, networks: cfg.wallet.networks, depositAddress: cfg.wallet.depositAddress });
const walletService = createWalletService({ ...cfg.wallet, dataRoot: DATA_ROOT, bridgeService, withdrawalPrivateKey: cfg.wallet.withdrawalPrivateKey });
const db = walletService.database;
const team = createATokenTeamService({ database: db, walletService });

const D = 18;
const fmt = u => formatUnits(BigInt(u || '0'), D);
const row0 = db.getATokenTeamLevel(wallet);

console.log('=== 快照表 a_token_team_level（重算前）===');
if (!row0) console.log('(无快照行，从未计算过)');
else console.log(JSON.stringify({
  level: row0.level, manualLevel: row0.manualLevel ?? '(无保底)',
  personalHeldA: fmt(row0.personalHeldUnits), teamHeldA: fmt(row0.teamHeldUnits),
  directValidCount: row0.directValidCount, updatedAt: new Date(Number(row0.updatedAt)).toLocaleString('zh-CN', { hour12:false }),
}, null, 2));

const wu = db.db.prepare('SELECT payload_json FROM wallet_users WHERE address=? COLLATE NOCASE').get(wallet);
console.log('\n=== wallet_users ===');
if (wu) {
  let payloadLevel;
  try { payloadLevel = JSON.parse(wu.payload_json || '{}').level; } catch {}
  console.log('payload.level =', payloadLevel);
} else console.log('(无 wallet_users 行)');

console.log('\n=== 个人持有构成 ===');
const bal = walletService.balanceUnits(wallet, 'A');
console.log('钱包 A 余额      =', fmt(bal));
let stakeUnits = 0n;
const stakes = db.listATokenStakes(wallet);
for (const s of stakes) {
  if (s.status === 'active') {
    const out = splitStakePayment(s, s.totalEarnedUnits).outstanding;
    stakeUnits += out;
    console.log(`  active 质押 id=${s.id || s.stakeId} 剩余本金=${fmt(out)}`);
  }
}
console.log('在押质押本金合计 =', fmt(stakeUnits), `(${stakes.filter(s=>s.status==='active').length} 笔 active)`);
let minerUnits = 0n;
const miners = db.listATokenMiners(wallet);
for (const m of miners) {
  if (m.status === 'active') {
    const remain = BigInt(m.totalUnits || '0') - BigInt(m.totalEarnedUnits || '0');
    if (remain > 0n) { minerUnits += remain; console.log(`  active 矿机 ${m.plan || m.id} 剩余未产出=${fmt(remain)}`); }
  }
}
console.log('矿机剩余合计     =', fmt(minerUnits), `(${miners.filter(m=>m.status==='active').length} 台 active) — 新口径下【不计入】个人业绩`);
const personal = bal + stakeUnits;
console.log('>>> 个人持有合计 =', fmt(personal), '(钱包余额 + 在押质押本金，2026-09-27 新口径)');

console.log('\n=== 实时重算（snapshot，页面打开也会执行）===');
const r = team.snapshot(wallet);
console.log('重算结果 level =', r.level, '| personalA =', r.personalA, '| teamA =', r.teamA);
const row1 = db.getATokenTeamLevel(wallet);
console.log('重算后 manualLevel =', row1?.manualLevel ?? '(无保底)');
if (row0 && Number(row0.level) !== Number(row1.level)) {
  console.log(`>>> 等级变化：${row0.level} -> ${row1.level}（重算即生效，说明此前只是快照未刷新）`);
} else if (row1?.manualLevel > 0 && Number(row1.manualLevel) > r.level) {
  console.log(`>>> 等级被保底锁住：自动等级=${r.level}，manualLevel 保底=${row1.manualLevel}（只升不降，所以不降级）`);
} else {
  console.log('>>> 重算后等级未变且无保底：当前个人/团队持仓仍满足该等级门槛（质押本金+矿机剩余也算持有）');
}

console.log('\n=== 等级门槛对照 ===');
for (const t of team.TEAM_LEVELS) {
  const mark = t.level === r.level ? '  <== 当前' : '';
  console.log(`A${t.level}: 个人≥${t.personalHeld} 团队≥${t.teamHeld}${mark}`);
}

const ov = db.getATokenTeamStatsOverride?.(wallet);
console.log('\n=== 后台虚拟展示覆盖 ===');
console.log(ov ? JSON.stringify(ov, null, 2) : '(无覆盖行)');
console.log('\nDIAG_DONE');
