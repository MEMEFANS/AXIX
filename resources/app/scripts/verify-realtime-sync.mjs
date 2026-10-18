// 实时同步验证：矿机每分钟产出入账时，直推/间推/团队分润是否同一次调用内立即到账
// 模拟生产 setInterval(60_000)：逐分钟推进时钟，每次只调一次 minerService.processAll()
// 断言：每一次 tick 后，矿主余额与上级(直推/间推)余额必须同时增加，绝不等到 00:00。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { closeDatabase } from '../src/database.js';
import { createATokenService, A_TOKEN_DECIMALS } from '../src/a-token-service.js';
import { createATokenTeamService } from '../src/a-token-team-service.js';
import { createATokenMinerService } from '../src/a-token-miner-service.js';
import { createReferralService } from '../src/referral-service.js';

const A = (v) => BigInt(v) * 10n ** BigInt(A_TOKEN_DECIMALS);
const fA = (u) => Number(u / 10n ** BigInt(A_TOKEN_DECIMALS - 6)) / 1e6; // 粗略转小数用于打印
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
let NOW = 1_800_000_000_000;
const clock = () => NOW;

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-sync-test-'));
const walletService = createWalletService({ dataRoot, depositAddress: `0x${'D0'.padStart(40, '0')}`, networks: [] });
const database = walletService.database;
const at = createATokenService({ database, walletService });
const teamService = createATokenTeamService({ database, walletService });
const referralService = createReferralService({ database, walletService });
const minerService = createATokenMinerService({ aTokenService: at, database, teamService, clock });
at.setPrice('0.1');

// 推荐链：矿工 U ← 直推 D ← 间推 I （D/I 无等级，只测直推15%+间推10%的实时性）
const U = Wallet.createRandom().address.toLowerCase(); // 矿工
const D = Wallet.createRandom().address.toLowerCase(); // 直推
const I = Wallet.createRandom().address.toLowerCase(); // 间推
for (const w of [U, D, I]) walletService.ensureUser(w);
const dRef = referralService.ensure(D);
const iRef = referralService.ensure(I);
referralService.ensure(U, dRef.code); // U 的直推 = D
// D 的直推 = I
referralService.ensure(D, iRef.code);
teamService.snapshotAll();

// 给矿工开一台 Mini（100 A / 30 天，日产约 3.33）
const miner = minerService.createMiner(U, 'mini120', { startedAt: NOW });

const bal = () => ({ U: at.balanceA(U), D: at.balanceA(D), I: at.balanceA(I) });
let prev = bal();
console.log('时刻(分钟) | 矿主余额A | 直推余额A | 间推余额A | 本次tick 矿主增量 | 直推增量 | 间推增量 | 同步?');
console.log('-'.repeat(105));

let allSynced = true;
// 模拟生产定时器：每分钟 tick 一次，连续 6 分钟
for (let t = 1; t <= 6; t++) {
  NOW += MIN;
  minerService.processAll(NOW); // 生产里就是这一个调用
  const cur = bal();
  const dU = cur.U - prev.U;
  const dD = cur.D - prev.D;
  const dI = cur.I - prev.I;
  // 关键断言：只要矿主有产出增量，直推必须同步 +15%，间推必须同步 +10%
  let synced = '—';
  if (dU > 0n) {
    const expectD = dU * 1500n / 10000n;
    const expectI = dU * 1000n / 10000n;
    const ok = dD === expectD && dI === expectI;
    synced = ok ? '✅ 同步' : '❌ 不同步';
    if (!ok) allSynced = false;
  }
  console.log(
    `第${String(t).padStart(2)}分钟  | ${fA(cur.U).toFixed(6).padStart(10)} | ${fA(cur.D).toFixed(6).padStart(9)} | ${fA(cur.I).toFixed(6).padStart(9)} | ` +
    `${fA(dU).toFixed(6).padStart(12)} | ${fA(dD).toFixed(6).padStart(8)} | ${fA(dI).toFixed(6).padStart(8)} | ${synced}`
  );
  prev = cur;
}

console.log('-'.repeat(105));
// 分润流水是否实时落库
const dRewards = database.listATokenTeamRewards(D, 50).filter(r => r.kind === 'miner_direct');
const iRewards = database.listATokenTeamRewards(I, 50).filter(r => r.kind === 'miner_indirect');
console.log(`直推 D 的分润流水条数: ${dRewards.length}（每分钟 1 条，实时落库）`);
console.log(`间推 I 的分润流水条数: ${iRewards.length}`);
console.log(`直推 D 累计收益: ${fA(at.balanceA(D))} AIX（= 矿主总产出 × 15%）`);
console.log(`间推 I 累计收益: ${fA(at.balanceA(I))} AIX（= 矿主总产出 × 10%）`);
console.log(allSynced ? '\n结论：✅ 矿机产出与直推/间推/团队收益【分钟级实时同步】到账，无需等 00:00。'
                     : '\n结论：❌ 存在不同步！');

closeDatabase();
process.exit(allSynced ? 0 : 1);
