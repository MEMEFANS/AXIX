import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { closeDatabase } from '../src/database.js';
import { createATokenService, A_TOKEN_DECIMALS } from '../src/a-token-service.js';
import { createATokenTeamService } from '../src/a-token-team-service.js';
import { createATokenMinerService } from '../src/a-token-miner-service.js';
import { createATokenStakingService } from '../src/a-token-staking-service.js';
import { createATokenTransferService } from '../src/a-token-transfer-service.js';
import { createATokenOrderService } from '../src/a-token-order-service.js';
import { createReferralService } from '../src/referral-service.js';

// ══════════════════════════════════════════════════════════════
// A 币生态端到端功能测试：矿机产出 / 团队分润 / 质押 / P2P 挂单撮合 /
// 代币互转 / A10 分红池日结 / 等级评定
// 规则口径见 玩法介绍.md（直推15% + 间推10% + 级差/平级/A10特例）
// ══════════════════════════════════════════════════════════════

const A = v => BigInt(v) * 10n ** BigInt(A_TOKEN_DECIMALS);
const U6 = v => BigInt(v) * 10n ** 6n;
const dayMs = 24 * 60 * 60_000;
// 北京日界（UTC+8）：受控时钟对齐北京 00:00，保证整日结算断言
const bjDayStart = ts => Math.floor((Number(ts) + 8 * 3600_000) / dayMs) * dayMs - 8 * 3600_000;
let NOW = bjDayStart(1_800_000_000_000); // 受控时钟（北京某日 00:00 整）
const clock = () => NOW;
const pass = msg => console.log(`  ✓ ${msg}`);

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-atoken-eco-test-'));
try {
  const walletService = createWalletService({ dataRoot, depositAddress:`0x${'D0'.padStart(40, '0')}`, networks:[] });
  const database = walletService.database;
  // 注意：aTokenService（燃烧/每日固定销毁补足）与交易/互转用真实时钟；
  // 受控时钟 NOW 仅用于矿机 release / 质押日结的时间推进。
  const at = createATokenService({ database, walletService });
  const teamService = createATokenTeamService({ database, walletService });
  const referralService = createReferralService({ database, walletService });
  // 受控时钟快速推进时，逐钱包更新快照，避免生产全量快照的 30 秒节流。
  const refreshLevels = () => {
    const wallets = new Set(database.listReferralLinks().flatMap(link => [link.wallet, link.referrerWallet]).filter(Boolean));
    for (const wallet of wallets) teamService.snapshot(wallet);
  };
  const minerService = createATokenMinerService({ aTokenService: at, database, teamService, clock });
  const stakingService = createATokenStakingService({ aTokenService: at, database, teamService, clock });
  const transferService = createATokenTransferService({ aTokenService: at, database, referralService, teamService });
  const orderService = createATokenOrderService({ aTokenService: at, database, teamService, referralService });

  at.setPrice('0.1'); // 1 AIX = 0.1 USDT

  // ── 钱包与推荐链 ──
  // 链1（级差示例）：R1 → U1(A6) → U2(A1) → U3(A2,矿工) → U4(仅持仓)；U5 挂在 U2 下做大团队
  // 链2（平级）：    P  → Q1(A3) → Q2(A3,矿工) → Q3(仅持仓)
  // 链3（A10 特例）：W  → V1(A10) → V2(A9,矿工) → V3(仅持仓)
  const R1 = Wallet.createRandom().address.toLowerCase();
  const U1 = Wallet.createRandom().address.toLowerCase();
  const U2 = Wallet.createRandom().address.toLowerCase();
  const U3 = Wallet.createRandom().address.toLowerCase();
  const U4 = Wallet.createRandom().address.toLowerCase();
  const U5 = Wallet.createRandom().address.toLowerCase();
  const P  = Wallet.createRandom().address.toLowerCase();
  const Q1 = Wallet.createRandom().address.toLowerCase();
  const Q2 = Wallet.createRandom().address.toLowerCase();
  const Q3 = Wallet.createRandom().address.toLowerCase();
  const W  = Wallet.createRandom().address.toLowerCase();
  const V1 = Wallet.createRandom().address.toLowerCase();
  const V2 = Wallet.createRandom().address.toLowerCase();
  const V3 = Wallet.createRandom().address.toLowerCase();

  const link = (child, parent) => {
    const pl = referralService.ensure(parent);
    referralService.ensure(child, pl.code);
  };
  for (const w of [R1, U1, U2, U3, U4, U5, P, Q1, Q2, Q3, W, V1, V2, V3]) walletService.ensureUser(w); // 先建 wallet_users 满足 FK
  link(U1, R1); link(U2, U1); link(U3, U2); link(U4, U3); link(U5, U2);
  link(Q1, P);  link(Q2, Q1); link(Q3, Q2);
  link(V1, W);  link(V2, V1); link(V3, V2);

  // 动态奖励要求参与者激活过；只持余额不满足当前有效用户规则。
  for (const w of [R1, U1, U2, P, Q1, V1, W]) {
    database.upsertATokenActivationRow({
      id: `fixture_activation_${w}`, wallet: w, plan: 'mini120',
      bnbAmountWei: '1', txHash: w.padEnd(66, '0'), status: 'confirmed',
      createdAt: NOW, confirmedAt: NOW,
    });
  }

  // ── 持仓（满足等级门槛，见 a-token-team-service.js TEAM_LEVELS）──
  // 规则：本人级别 = 余额 + 质押中本金；团队业绩 = 只算下级质押中本金（下级余额不算）
  // 本人持有（余额）用于维持本人级别；下级团队业绩通过质押构造
  walletService.creditBalance(U4, 'A', A(10_000));  stakingService.stake(U4, 'current', '10000');  // U4 质押 1 万 → U3 团队 1 万 → A2
  walletService.creditBalance(U3, 'A', A(2_000));    // U3 个人 2000（余额）→ A2
  walletService.creditBalance(U5, 'A', A(1_000_000)); stakingService.stake(U5, 'current', '1000000'); // U5 质押 100 万 → U2 团队做大，供 U1 升 A6
  walletService.creditBalance(U2, 'A', A(1_500));    // U2 个人 1500（不足 A2 门槛）+ 团队 ≥5000 → A1
  walletService.creditBalance(U1, 'A', A(32_000));   // U1 个人 3.2 万 → A6（团队 = U2质押0 + U3质押0 + U4质押1万 + U5质押100万 = 101万）
  walletService.creditBalance(Q3, 'A', A(50_000));   stakingService.stake(Q3, 'current', '50000');   // Q3 质押 5 万 → Q2 团队 5 万 → A3
  walletService.creditBalance(Q2, 'A', A(4_000));    // Q2 个人 4000 → A3
  walletService.creditBalance(Q1, 'A', A(4_000));    // Q1 团队 = Q2质押0 + Q3质押5万 = 5万 → A3
  walletService.creditBalance(V3, 'A', A(100_000_000)); stakingService.stake(V3, 'current', '100000000'); // V3 质押 1 亿 → V2 团队 1 亿 → A9
  walletService.creditBalance(V2, 'A', A(256_000));  // V2 个人 25.6 万 → A9
  walletService.creditBalance(V1, 'A', A(500_000));  // V1 个人 50 万 → A10
  walletService.creditBalance(W,  'A', A(1_000));
  walletService.creditBalance(R1, 'A', A(1_000));
  walletService.creditBalance(P,  'A', A(1_000));

  // 先结算构造用大额质押的当日利息及分润，避免后续余额被污染
  NOW = bjDayStart(NOW);
  stakingService.processAll(NOW);
  refreshLevels();

  // ── 等级评定断言 ──
  assert.equal(teamService.getLevel(U1), 6, 'U1 应为 A6');
  assert.equal(teamService.getLevel(U2), 1, 'U2 应为 A1（个人 1500 不足 A2 门槛）');
  assert.equal(teamService.getLevel(U3), 2, 'U3 应为 A2');
  assert.equal(teamService.getLevel(U4), 0, 'U4 无团队应为 A0');
  assert.equal(teamService.getLevel(Q1), 3, 'Q1 应为 A3');
  assert.equal(teamService.getLevel(Q2), 3, 'Q2 应为 A3');
  assert.equal(teamService.getLevel(V1), 10, 'V1 应为 A10');
  assert.equal(teamService.getLevel(V2), 9, 'V2 应为 A9');
  assert.equal(teamService.calcLevel(A(999), A(5_000_000)), 0, '个人不足 1000 不能升级');
  assert.equal(teamService.calcLevel(A(1000), A(5000)), 1, 'A1 门槛：个人1000+团队5000');
  assert.equal(teamService.calcLevel(A(500_000), A(100_000_000)), 10, 'A10 门槛：个人50万+团队1亿');
  pass('等级评定（A1~A10 门槛 + 团队递归累加）');

  // ════════════════ 一、矿机产出 + 团队分润 ════════════════
  console.log('一、矿机产出与团队分润');

  // ── 1.1 套餐参数 ──
  const mini = minerService.MINER_PLANS.mini120;
  const pro = minerService.MINER_PLANS.pro1500;
  assert.equal(BigInt(mini.totalUnits), A(100));
  assert.equal(mini.days, 30);
  assert.equal(BigInt(pro.totalUnits), A(1500));
  assert.equal(pro.days, 90);
  assert.equal(BigInt(minerService.dailyTargetOf('mini120')), A(100) / 30n, 'mini 日产 = 100/30');
  pass('矿机套餐参数（Mini 矿机 100/30天，Pro 矿机 1500/90天）');

  // ── 1.1b 北京日结：不到 00:00（北京）不产出；跨 00:00 只结完整日；一天一条流水 ──
  const m0 = minerService.createMiner(U4, 'mini120', { startedAt: NOW });
  NOW += 12 * 3600_000; // 北京当天中午
  minerService.processAll(NOW);
  assert.equal(BigInt(minerService.present(U4).find(m => m.id === m0.id).totalEarnedUnits), 0n, '未到北京 00:00 不结算');
  NOW += 12 * 3600_000 + 3_600_000; // 次日 01:00（北京）
  minerService.processAll(NOW);
  assert.equal(BigInt(minerService.present(U4).find(m => m.id === m0.id).totalEarnedUnits), A(100) / 30n, '跨过北京 00:00 结 1 个完整日');
  const m0Releases = database.listATokenMinerReleases(U4, 50).filter(r => r.minerId === m0.id);
  assert.equal(m0Releases.length, 1, '矿机流水一天一条（不再每分钟一条）');
  minerService.processAll(NOW); // 同日重复巡检
  assert.equal(database.listATokenMinerReleases(U4, 50).filter(r => r.minerId === m0.id).length, 1, '同日重复巡检不重复入账');
  minerService.forceExpire(m0.id, { payRemaining: false });
  pass('北京日结：00:00 前不产出、跨日结完整日、一天一条且幂等');

  // ── 1.2 级差分润：矿工 A2，直推 A1（倒挂拿0且不占空间），间推 A6 拿级差 40% ──
  // 逐层减法口径：直推15% + 间推10%；U2(A1)倒挂于产单人A2→级差0且档位不占用空间；U1(A6)拿 60%-20%=40%
  const m1 = minerService.createMiner(U3, 'mini120', { startedAt: bjDayStart(NOW) });
  let pre = { U3: at.balanceA(U3), U2: at.balanceA(U2), U1: at.balanceA(U1) };
  NOW += 2 * dayMs;
  minerService.processAll(NOW);
  const g1 = at.balanceA(U3) - pre.U3;                                  // 矿工本人 2 天产出
  assert.equal(g1, 2n * (A(100) / 30n), '矿工 2 天产出 = 2 × 100/30 A');
  assert.equal(at.balanceA(U2) - pre.U2, g1 * 1500n / 10000n, '直推 U2(A1倒挂) 只拿 15%');
  assert.equal(at.balanceA(U1) - pre.U1,
    g1 * 1000n / 10000n + g1 * 4000n / 10000n, '间推 U1 拿 10% + A6级差40%（A1倒挂不占空间：60%-20%）');
  const u1Rewards = database.listATokenTeamRewards(U1, 50);
  assert.ok(u1Rewards.some(r => r.kind === 'miner_indirect'), '应有 miner_indirect 分润记录');
  assert.ok(u1Rewards.some(r => r.kind === 'miner_level_diff'), '应有 miner_level_diff 分润记录');
  pass('级差分润：直推15% + 间推10% + A6级差40%，倒挂节点拿0不占空间');

  // 分润是"额外发放"，矿工本人产出全额到账（未被扣减）
  assert.equal(g1, 2n * (A(100) / 30n), '矿工本人 100% 到账');
  minerService.forceExpire(m1.id, { payRemaining: false }); // 结束该矿机，避免污染后续窗口

  // ── 1.3 矿工无级别（A0）：U3(A2) 伞下无级别拿满档位=团队奖20%，U2(A1) 倒挂拿0，U1(A6) 拿级差40% ──
  // （U4 已在 1.1 激活过 mini120，同套餐不可重复激活 → 这里用 pro1500）
  const m2 = minerService.createMiner(U4, 'pro1500', { startedAt: bjDayStart(NOW) });
  pre = { U4: at.balanceA(U4), U3: at.balanceA(U3), U2: at.balanceA(U2), U1: at.balanceA(U1) };
  NOW += dayMs;
  minerService.processAll(NOW);
  const g2 = at.balanceA(U4) - pre.U4;
  assert.equal(at.balanceA(U3) - pre.U3, g2 * 1500n / 10000n + g2 * 2000n / 10000n,
    '产单人 A0：直推 U3(A2) = 15% + 团队奖20%（伞下无级别拿满档位）');
  assert.equal(at.balanceA(U2) - pre.U2, g2 * 1000n / 10000n, '间推 U2(A1) 倒挂拿0，只拿间推固定 10%');
  assert.equal(at.balanceA(U1) - pre.U1, g2 * 4000n / 10000n, 'U1(A6) 拿级差 60%-20%=40%（倒挂不占空间）');
  minerService.forceExpire(m2.id, { payRemaining: false });
  pass('矿工 A0：直推拿团队奖20%，倒挂不占空间，A6 拿级差40%');

  // ── 1.4 同级链上拿0不占空间：直推与矿工同为 A3 → 只拿直推 15%（平级奖改按日结算）──
  const m3 = minerService.createMiner(Q2, 'mini120', { startedAt: bjDayStart(NOW) });
  pre = { Q2: at.balanceA(Q2), Q1: at.balanceA(Q1), P: at.balanceA(P) };
  NOW += dayMs;
  minerService.processAll(NOW);
  const g3 = at.balanceA(Q2) - pre.Q2;
  assert.equal(at.balanceA(Q1) - pre.Q1, g3 * 1500n / 10000n, '直推 Q1(A3) 只拿 15%（同级链上拿0不占空间）');
  assert.equal(at.balanceA(P) - pre.P, g3 * 1000n / 10000n, '间推 P 拿 10%');
  minerService.forceExpire(m3.id, { payRemaining: false });
  pass('同级不占空间：直推拿 15%，链上不再发平级奖');

  // ── 1.4b 平级奖（按日结算）：直推同级下级当日团队收益（团队奖+级差）的 10%，每日一条 ──
  // 链2：P(A0) → Q1(A3) → Q2(A3) → Q3(A0,矿工)。Q3 无级别 → Q2 拿团队奖 30%，
  //      Q1 与 Q2 同级 → 链上拿 0；日结时 Q1 拿 Q2 当日团队收益的 10%（即产出的 3%），另拿间推 10%。
  const m3b = minerService.createMiner(Q3, 'mini120', { startedAt: bjDayStart(NOW) });
  pre = { Q1: at.balanceA(Q1), Q2: at.balanceA(Q2), Q3: at.balanceA(Q3) };
  NOW += dayMs;
  minerService.processAll(NOW);
  teamService.settleParityRewards(bjDayStart(NOW) + dayMs); // 次日结算前一北京日的平级奖（生产环境由 60s 定时器在矿机/质押日结后调用）
  const q3Out = at.balanceA(Q3) - pre.Q3;                     // Q3 本日产出（本人全额到账）
  assert.ok(q3Out > 0n, 'Q3 矿机应有产出');
  const baseQ2 = q3Out * 3000n / 10000n;                      // Q2 当日团队收益（团队奖30%，计平级基数）
  assert.equal(at.balanceA(Q2) - pre.Q2,
    q3Out * 1500n / 10000n + baseQ2, 'Q2 拿直推15% + 团队奖30%');
  const expectQ1 = q3Out * 1000n / 10000n + baseQ2 * 1000n / 10000n; // 间推10% + 平级10%×团队收益
  assert.equal(at.balanceA(Q1) - pre.Q1, expectQ1, 'Q1 拿间推10% + 平级奖（Q2 当日团队收益的10%）');
  const q1Parity = database.listATokenTeamRewards(Q1, 200).filter(r => r.kind === 'parity');
  assert.equal(q1Parity.length, 1, '平级奖每日仅一条记录');
  assert.equal(BigInt(q1Parity[0].amountUnits), baseQ2 * 1000n / 10000n, '平级奖金额 = 下级当日团队收益 × 10%');
  const balQ1 = at.balanceA(Q1);
  teamService.settleParityRewards(bjDayStart(NOW) + dayMs); // 同日重跑：幂等不重复发放
  assert.equal(at.balanceA(Q1), balQ1, '平级奖幂等：重跑不重复入账');
  assert.equal(database.listATokenTeamRewards(Q1, 200).filter(r => r.kind === 'parity').length, 1, '重跑不新增记录');
  minerService.forceExpire(m3b.id, { payRemaining: false });
  pass('平级奖按日结算：直推同级下级当日团队收益 10%，一天一条且幂等');

  // ── 1.5 A10 特例：A10 上级挡住级差扫描，只拿直推 15% ──
  const m4 = minerService.createMiner(V2, 'mini120', { startedAt: bjDayStart(NOW) });
  pre = { V2: at.balanceA(V2), V1: at.balanceA(V1), W: at.balanceA(W) };
  NOW += dayMs;
  minerService.processAll(NOW);
  const g4 = at.balanceA(V2) - pre.V2;
  assert.equal(at.balanceA(V1) - pre.V1, g4 * 1500n / 10000n, 'A10 直推只拿 15%，不拿级差');
  assert.equal(at.balanceA(W) - pre.W, g4 * 1000n / 10000n, '间推 W 拿 10%');
  assert.equal(database.listATokenTeamLevelsByLevel(10).length, 1, '全网仅 V1 一位 A10');
  pass('A10 特例：级差扫描被 A10 挡住（break），A10 收益改走手续费分红池');

  // ════════════════ 二、质押生息 ════════════════
  console.log('二、质押（生息）');

  // ── 2.1 活期：日结 0.3%，随进随出 ──
  const S1 = Wallet.createRandom().address.toLowerCase();
  walletService.creditBalance(S1, 'A', A(10_000));
  NOW = bjDayStart(NOW); // 质押从北京 00:00 起息
  const stake1 = stakingService.stake(S1, 'current', '100');
  assert.equal(at.balanceA(S1), A(9_900), '质押扣减本金');
  NOW += dayMs + 3_600_000;
  stakingService.processAll(NOW);
  assert.equal(at.balanceA(S1), A(9_900) + A(100) * 30n / 10000n, '活期日结 = 本金 × 0.3%');
  stakingService.unstake(S1, stake1.id);
  assert.equal(at.balanceA(S1), A(10_000) + A(100) * 30n / 10000n, '活期赎回全额返还本金');
  pass('活期质押：日结 0.3%，赎回返本不扣罚');

  // ── 2.2 定期 1号30天：日产 = 本金/30 + 本金×0.8%，到期本息 1240 ──
  const S2 = Wallet.createRandom().address.toLowerCase();
  walletService.creditBalance(S2, 'A', A(10_000));
  await assert.rejects(async () => stakingService.stake(S2, 's30', '999'), /最小质押/, '低于最小起存应拒绝');
  NOW = bjDayStart(NOW); // 对齐北京 00:00 起息
  const stake2 = stakingService.stake(S2, 's30', '1000');
  NOW += 5 * dayMs;
  stakingService.processAll(NOW);
  const fiveDay = 5n * (A(1000) / 30n) + 5n * (A(1000) * 80n / 10000n);
  assert.equal(at.balanceA(S2), A(9_000) + fiveDay, '5 天产出 = 5×(本金/30 + 0.8%利息)，账户含剩余本金 9000');
  await assert.rejects(async () => stakingService.unstake(S2, stake2.id), /不可提前赎回/, '定期不可提前赎回');
  NOW += 26 * dayMs; // 越过 30 天到期
  stakingService.processAll(NOW);
  const stake2After = stakingService.present(S2).find(s => s.id === stake2.id);
  assert.equal(stake2After.status, 'completed', '到期自动结清');
  assert.equal(Number(stake2After.totalEarned), 1240, '到期本息 = 1000 + 24% = 1240（含尾差补齐）');
  assert.equal(at.balanceA(S2), A(10_000) - A(1000) + A(1240), '账户净增 24% 收益');
  pass('定期质押：每日滴灌本息，到期自动结清 1240 枚（本金+24%）');

  // ── 2.3 余额不足/套餐无效 ──
  await assert.rejects(async () => stakingService.stake(S2, 's90', '99999'), /余额不足/, 'A 币余额不足应拒绝');
  await assert.rejects(async () => stakingService.stake(S2, 'nope', '100'), /质押套餐无效/, '无效套餐应拒绝');
  pass('质押边界校验（最小起存/余额/套餐）');

  // ── 2.4 质押团队分润：比例与矿机一致（直推15% + 间推10% + 级差/平级）──
  // 推荐链 U3(A2) → U2(A1) → U1(A6)：U2 拿直推15%，U1 拿间推10% + A6级差40%（A1 上级被跳过）
  // 赎回构造团队业绩用的大额活期质押 + 清钱包余额（新逻辑下钱包持有也算团队业绩）
  for (const s of stakingService.present(U4)) if (s.status === 'active') stakingService.unstake(U4, s.id);
  for (const s of stakingService.present(U5)) if (s.status === 'active') stakingService.unstake(U5, s.id);
  for (const s of stakingService.present(Q3)) if (s.status === 'active') stakingService.unstake(Q3, s.id);
  for (const s of stakingService.present(V3)) if (s.status === 'active') stakingService.unstake(V3, s.id);
  // 新逻辑：钱包持有的 AIX 也算团队业绩 → 赎回后本金退回钱包会保持业绩
  // 所以这里需要把大额余额扣掉（包括之前分润发到的钱包收益），让 U1/U2/U3 回到低等级
  // 注意：不要清 V1/V2/V3，后面 A10 分红池测试还要用
  for (const w of [U1, U2, U3, U4, U5, Q3]) {
    const bal = walletService.balanceUnits(w, 'A');
    if (bal > 0n) walletService.debitBalance(w, 'A', bal.toString());
  }
  // 只给 U3 留够下一次质押 + 一点点个人余额
  walletService.creditBalance(U3, 'A', A(1_000)); // U3 质押 1000
  walletService.creditBalance(U2, 'A', A(1_500)); // U2 个人 1500
  refreshLevels(); // 重算等级
  const preStake = { U3: at.balanceA(U3), U2: at.balanceA(U2), U1: at.balanceA(U1) };
  const stake3 = stakingService.stake(U3, 'current', '1000');
  NOW += dayMs;
  stakingService.processAll(NOW);
  const sg = A(1000) * 30n / 10000n; // 活期日息 = 1000 × 0.3% = 0.3 A
  assert.equal(at.balanceA(U3), preStake.U3 - A(1000) + sg, '质押人：扣本金 1000 + 日息 0.3 全额到账');
  assert.equal(at.balanceA(U2) - preStake.U2, sg * 1500n / 10000n, '直推 U2 拿质押收益 15%');
  assert.equal(at.balanceA(U1) - preStake.U1,
    sg * 1000n / 10000n, '下级赎回后业绩不足，U1 只拿间推 10%，不沿用旧 A6 快照');
  const u2StakeRewards = database.listATokenTeamRewards(U2, 50);
  const u1StakeRewards = database.listATokenTeamRewards(U1, 50);
  assert.ok(u2StakeRewards.some(r => r.kind === 'stake_direct'), '应有 stake_direct 分润记录');
  assert.ok(u1StakeRewards.some(r => r.kind === 'stake_indirect'), '应有 stake_indirect 分润记录');
  assert.equal(teamService.getLevel(U1), 0, '团队本金赎回后级别及时更新');
  // 幂等：同日重复结算不重复发放
  stakingService.processAll(NOW);
  assert.equal(at.balanceA(U2) - preStake.U2, sg * 1500n / 10000n, '同日重复结算不重复分润');
  // 赎回返本后余额 = 质押前 + 净赚利息
  stakingService.unstake(U3, stake3.id);
  assert.equal(at.balanceA(U3), preStake.U3 + sg, '活期赎回返本 1000，分润不影响质押人本金');
  pass('质押团队分润：直推15% + 间推10%，级别按实时在押业绩判定，重复结算幂等');

  // ════════════════ 三、现货交易（P2P 挂单撮合） ════════════════
  console.log('三、现货交易（挂单撮合）');

  // 卖方直推有效人数阶梯：validDirectCount 统计"有效本金"——
  //   ① AI 跟单 active 批次  ② AIX 矿机运行中  ③ AIX 质押运行中（三选一即可）
  const withNValidDirects = (owner, n) => {
    walletService.ensureUser(owner); // 满足 FK
    const ol = referralService.ensure(owner);
    for (let i = 0; i < n; i++) {
      const d = Wallet.createRandom().address.toLowerCase();
      walletService.ensureUser(d); // 满足 FK
      walletService.creditBalance(d, 'A', A(10_000)); // 激活矿机需要余额
      referralService.ensure(d, ol.code);
      minerService.createMiner(d, 'mini120', { startedAt: NOW });
    }
  };

  // ── 3.1 限价报价预览 ──
  const q50 = orderService.quoteLimitOrder({ side:'sell', priceUsdt:'0.1', amount:'100', wallet:R1 });
  assert.equal(q50.feePct, '50%', '0 有效直推 → 卖出 50% 手续费');
  withNValidDirects(R1, 2);
  assert.equal(referralService.validDirectCount(R1), 2, '2 个持跟单本金直推');
  const q40 = orderService.quoteLimitOrder({ side:'sell', priceUsdt:'0.1', amount:'100', wallet:R1 });
  assert.equal(q40.feePct, '40%', '2 有效直推 → 40%');
  withNValidDirects(R1, 8);
  const q30 = orderService.quoteLimitOrder({ side:'sell', priceUsdt:'0.1', amount:'100', wallet:R1 });
  assert.equal(q30.feePct, '3%', '≥10 有效直推 → 3%');

  // ── 3.1a 矿机/质押也算有效本金 → 上级费率同样降档 ──
  const SM = Wallet.createRandom().address.toLowerCase();
  walletService.ensureUser(SM);
  walletService.creditBalance(SM, 'A', A(10_000));
  // 下级只开矿机，不开跟单/质押
  const smLink = referralService.ensure(SM);
  const minerKid1 = Wallet.createRandom().address.toLowerCase();
  const minerKid2 = Wallet.createRandom().address.toLowerCase();
  walletService.ensureUser(minerKid1); walletService.ensureUser(minerKid2);
  referralService.ensure(minerKid1, smLink.code);
  referralService.ensure(minerKid2, smLink.code);
  minerService.createMiner(minerKid1, 'mini120', { startedAt: NOW });
  minerService.createMiner(minerKid2, 'mini120', { startedAt: NOW });
  assert.equal(referralService.validDirectCount(SM), 2, '矿机 active 下级应算有效直推');
  assert.equal(orderService.quoteLimitOrder({ side:'sell', priceUsdt:'0.1', amount:'100', wallet:SM }).feePct, '40%', '矿机下级让 SM 降档到 40%');
  // 再加质押下级
  const stakeKid = Wallet.createRandom().address.toLowerCase();
  walletService.ensureUser(stakeKid);
  walletService.creditBalance(stakeKid, 'A', A(1_000));
  referralService.ensure(stakeKid, smLink.code);
  stakingService.stake(stakeKid, 'current', '100');
  assert.equal(referralService.validDirectCount(SM), 3, '质押 active 下级也算有效直推');
  assert.equal(orderService.quoteLimitOrder({ side:'sell', priceUsdt:'0.1', amount:'100', wallet:SM }).feePct, '40%', '3 有效直推仍在 40% 档');
  // 矿机到期后自动失效
  NOW += 31 * dayMs;
  minerService.processAll(NOW);
  assert.equal(referralService.validDirectCount(SM), 1, '矿机到期后不再算有效直推（只剩质押）');
  pass('矿机/质押 active 同样降低上级卖出费率（与跟单口径一致）');

  // ── 3.2 全额成交：卖 200 A（0直推→50%费，费 100 + 净 100，按投入量收）@0.1，买 10 USDT = 100 A ──
  const SA = Wallet.createRandom().address.toLowerCase();
  const B1 = Wallet.createRandom().address.toLowerCase();
  walletService.ensureUser(SA);
  walletService.creditBalance(SA, 'A', A(10_000));
  walletService.creditBalance(B1, 'USDT', U6(1000));
  assert.equal(referralService.validDirectCount(SA), 0, 'SA 无直推 → 50% 档');
  pre = { bA: at.balanceA(B1), bU: at.balanceUsdt(B1), sA: at.balanceA(SA), sU: at.balanceUsdt(SA) };
  const burnBefore = at.totalBurned();
  const a10Before = BigInt(database.getA10Pool('current')?.accumUnits || '0');
  const sell1 = orderService.placeOrder({ wallet:SA, side:'sell', orderType:'limit', priceUsdt:'0.1', amount:'200' });
  assert.equal(sell1.orderStatus, 'OPEN', '先挂卖单等待对手方');
  assert.equal(sell1.lockedA, '200.0', '卖单只冻结卖出数量本身');
  const buy1 = orderService.placeOrder({ wallet:B1, side:'buy', orderType:'market', amount:'10' });
  assert.equal(buy1.orderStatus, 'FILLED', '买单全额成交');
  assert.equal(buy1.aReceived, '100.0', '买方 0 手续费，足额收 A');
  assert.equal(at.balanceA(B1) - pre.bA, A(100), '买家到账 100 A');
  assert.equal(pre.bU - at.balanceUsdt(B1), U6(10), '买家支付 10 USDT');
  assert.equal(at.balanceUsdt(SA) - pre.sU, U6(10), '卖家实收 10 USDT（无折损）');
  assert.equal(pre.sA - at.balanceA(SA), A(200), '卖家扣 200 A（100 净额 + 100 手续费，费按投入量 50%）');
  assert.equal(at.totalBurned() - burnBefore, A(50), '手续费 50% 销毁 = 50 A');
  assert.equal(BigInt(database.getA10Pool('current')?.accumUnits || '0') - a10Before, A(50), '手续费 50% 进 A10 池 = 50 A');
  const sell1After = orderService.myOrders({ wallet:SA }).find(o => o.orderId === sell1.orderId);
  assert.equal(sell1After.orderStatus, 'FILLED', '卖单同步全额成交');
  pass('挂单撮合全额成交：买方 0 费，卖方 50% 费（按投入量）→ 50 销毁 + 50 进 A10 池');

  // ── 3.3 部分成交 + 撤单退回 ──
  const B2 = Wallet.createRandom().address.toLowerCase();
  walletService.creditBalance(B2, 'USDT', U6(1000));
  const sell2 = orderService.placeOrder({ wallet:SA, side:'sell', orderType:'limit', priceUsdt:'0.1', amount:'150' });
  const buy2 = orderService.placeOrder({ wallet:B2, side:'buy', orderType:'market', amount:'1' });
  assert.equal(buy2.orderStatus, 'FILLED');
  assert.equal(at.balanceA(B2), A(10), '买家 1 USDT 买到 10 A');
  const sell2After = orderService.myOrders({ wallet:SA }).find(o => o.orderId === sell2.orderId);
  assert.equal(sell2After.orderStatus, 'OPEN', '卖单部分成交后剩余挂单');
  assert.equal(sell2After.inputA, '130.0', '卖单剩余 130 A（150 − 10 净额 − 10 费，费按投入量 50%）');
  const locks = orderService.myLocks(SA);
  assert.equal(locks.a, '130.0', '冻结展示 = 130 A');
  const cancel2 = orderService.cancelOrder({ wallet:SA, orderId:sell2.orderId });
  assert.equal(cancel2.refundA, '130.0', '撤单原路退回 130 A');
  assert.equal(at.balanceA(SA), A(10_000) - A(200) - A(20), '撤单后余额正确（200 全额成交 + 20 已成交净额+费）');
  await assert.rejects(async () => orderService.cancelOrder({ wallet:SA, orderId:sell2.orderId }), /仅 OPEN 状态可撤单/, '重复撤单应拒绝');
  pass('部分成交：剩余自动转委托，撤单原路退回冻结');

  // ── 3.4 40% 阶梯成交（2 有效直推）──
  const SB = Wallet.createRandom().address.toLowerCase();
  const B3 = Wallet.createRandom().address.toLowerCase();
  walletService.ensureUser(SB);
  withNValidDirects(SB, 2);
  walletService.creditBalance(SB, 'A', A(1_000));
  walletService.creditBalance(B3, 'USDT', U6(1000));
  assert.equal(referralService.validDirectCount(SB), 2);
  const burnBefore3 = at.totalBurned();
  const a10Before3 = BigInt(database.getA10Pool('current')?.accumUnits || '0');
  orderService.placeOrder({ wallet:SB, side:'sell', orderType:'limit', priceUsdt:'0.1', amount:'200' });
  const buy3 = orderService.placeOrder({ wallet:B3, side:'buy', orderType:'market', amount:'12' });
  assert.equal(buy3.aReceived, '120.0', '净额 120（费按投入量 40% = 80 A）');
  assert.equal(at.totalBurned() - burnBefore3, A(40), '40% 费=80 A，50% 销毁=40 A');
  assert.equal(BigInt(database.getA10Pool('current')?.accumUnits || '0') - a10Before3, A(40), '40% 费的 50% 进 A10 池');
  pass('40% 阶梯：2 有效直推卖方费率生效');

  // ── 3.5 3% 阶梯成交（≥10 有效直推）──
  const SC = Wallet.createRandom().address.toLowerCase();
  const B4 = Wallet.createRandom().address.toLowerCase();
  walletService.ensureUser(SC);
  withNValidDirects(SC, 10);
  assert.equal(referralService.validDirectCount(SC), 10);
  walletService.creditBalance(SC, 'A', A(1_000));
  walletService.creditBalance(B4, 'USDT', U6(1000));
  const burnBefore4 = at.totalBurned();
  orderService.placeOrder({ wallet:SC, side:'sell', orderType:'limit', priceUsdt:'0.1', amount:'200' });
  const buy4 = orderService.placeOrder({ wallet:B4, side:'buy', orderType:'market', amount:'19.4' });
  assert.equal(buy4.aReceived, '194.0', '净额 194（费按投入量 3% = 6 A）');
  assert.equal(at.totalBurned() - burnBefore4, A(30) / 10n, '3% 费=6 A，50% 销毁=3 A');
  pass('3% 阶梯：≥10 有效直推卖方费率生效');

  // ── 3.6 防自成交 + 深度/统计 ──
  const B5 = Wallet.createRandom().address.toLowerCase();
  walletService.creditBalance(B5, 'A', A(1_000));
  walletService.creditBalance(B5, 'USDT', U6(1000));
  const so = orderService.placeOrder({ wallet:B5, side:'sell', orderType:'limit', priceUsdt:'0.1', amount:'150' });
  const bo = orderService.placeOrder({ wallet:B5, side:'buy', orderType:'market', amount:'10' });
  assert.equal(bo.orderStatus, 'OPEN', '同钱包买卖不能自成交');
  const depth = orderService.depth();
  assert.ok(depth.openBuyCount >= 1 && depth.openSellCount >= 1, '委托簿深度统计');
  orderService.cancelOrder({ wallet:B5, orderId:bo.orderId });
  orderService.cancelOrder({ wallet:B5, orderId:so.orderId });
  assert.equal(at.balanceA(B5), A(1_000), '自成交两单撤回后 A 余额不变');
  assert.equal(at.balanceUsdt(B5), U6(1000), '自成交两单撤回后 USDT 余额不变');
  pass('防自成交 + 冻结/撤单资金一致');

  // ── 3.7 下单校验 ──
  const B6 = Wallet.createRandom().address.toLowerCase();
  walletService.creditBalance(B6, 'USDT', U6(1));
  await assert.rejects(async () => orderService.placeOrder({ wallet:B6, side:'buy', orderType:'market', amount:'10' }), /余额不足/, 'USDT 不足应拒绝');
  const b6Before = at.balanceUsdt(B6);
  const buyLimit = orderService.placeOrder({ wallet:B6, side:'buy', orderType:'limit', priceUsdt:'0.000001', amount:'1' });
  assert.ok(at.balanceUsdt(B6) < b6Before, '有效限价买单应冻结 USDT');
  orderService.cancelOrder({ wallet:B6, orderId:buyLimit.orderId });
  assert.equal(at.balanceUsdt(B6), b6Before, '撤销限价买单应返还冻结资金');
  await assert.rejects(async () => orderService.placeOrder({ wallet:B6, side:'sell', orderType:'limit', priceUsdt:'0.1', amount:'10' }), /余额不足/, 'A 不足应拒绝');
  await assert.rejects(async () => orderService.placeOrder({ wallet:B6, side:'hold', amount:'10' }), /side 必须是/, '非法 side 应拒绝');
  await assert.rejects(async () => orderService.placeOrder({ wallet:B5, side:'sell', orderType:'market', amount:'50' }), /最低 100/, '卖出低于 100 AIX 应拒绝');
  pass('下单边界校验');

  // ════════════════ 四、代币互转 ════════════════
  console.log('四、代币互转');

  const RCV = Wallet.createRandom().address.toLowerCase();
  const rcvId = at.ensureUserId(RCV).userId;
  const X1 = Wallet.createRandom().address.toLowerCase(); // 0 有效直推 → 50%
  walletService.creditBalance(X1, 'A', A(1_000));
  const burnBeforeTx = at.totalBurned();
  const a10BeforeTx = BigInt(database.getA10Pool('current')?.accumUnits || '0');
  const tx1 = transferService.transferByUserId(X1, rcvId, '100');
  assert.equal(tx1.feePct, '50%');
  assert.equal(tx1.net, '50.0', '接收方实收 50 A（转让方承担 50% 费）');
  assert.equal(at.balanceA(RCV), A(50), '收款方不承担任何费用');
  assert.equal(at.balanceA(X1), A(900), '转让方共扣 100 A');
  assert.equal(at.totalBurned() - burnBeforeTx, A(25), '互转费 50% 销毁');
  assert.equal(BigInt(database.getA10Pool('current')?.accumUnits || '0') - a10BeforeTx, A(25), '互转费 50% 进 A10 池');
  assert.equal(transferService.myTransfers(X1)[0].direction, 'out', '互转记录方向 out');

  // 40% 阶梯
  const X2 = Wallet.createRandom().address.toLowerCase();
  withNValidDirects(X2, 2);
  walletService.creditBalance(X2, 'A', A(1_000));
  const tx2 = transferService.transferByUserId(X2, rcvId, '100');
  assert.equal(tx2.feePct, '40%', '2 有效直推 → 40%');
  assert.equal(at.balanceA(RCV), A(110), '接收方实收 60 A');
  const quote = transferService.quote(X2, '100');
  assert.equal(quote.fee, '40.0', '互转报价与成交一致');
  pass('互转：转让方阶梯费率（50%/40%），收款方零费用，费 50% 销毁+50% 进池');

  // 边界
  const x1Id = at.ensureUserId(X1).userId;
  await assert.rejects(async () => transferService.transferByUserId(X1, x1Id, '10'), /不能向自己转账/, '自转应拒绝');
  await assert.rejects(async () => transferService.transferByUserId(X1, 'ZZZZ9999', '10'), /不存在/, '无效用户ID应拒绝');
  await assert.rejects(async () => transferService.transferByUserId(X1, rcvId, '99999'), /余额不足/, '余额不足应拒绝');
  await assert.rejects(async () => transferService.transferByUserId(X1, rcvId, '10'), /最低 20/, '互转低于 20 AIX 应拒绝');
  pass('互转边界校验');

  // ════════════════ 五、A10 分红池日结 ════════════════
  console.log('五、A10 分红池日结');
  const poolNow = BigInt(database.getA10Pool('current')?.accumUnits || '0');
  const expectedPool = (A(50) + A(50) / 10n + A(40) + A(30) / 10n) + (A(25) + A(20)); // 交易 4 笔（50%费100、部分成交费10、40%费80、3%费6，各50%入池）+ 互转 2 笔
  assert.equal(poolNow, expectedPool, '池累计 = 全部手续费的 50%');
  const v1Before = at.balanceA(V1);
  stakingService.stake(V3, 'current', '100000000'); // 重新满足 A10 的实际团队在押门槛
  at.debitA(V2, at.balanceA(V2) - A(256_000)); // 固定本次分红测试的 A10 参与者为 V1
  refreshLevels();
  const settle = teamService.settleA10Pool();
  assert.equal(settle.settled, true, '日结执行成功');
  assert.equal(settle.participantCount, 1, '仅 V1 一位 A10 参与');
  assert.equal(at.balanceA(V1) - v1Before, poolNow, 'V1 均分全池');
  assert.equal(BigInt(database.getA10Pool('current')?.accumUnits || '0'), 0n, '日结后池清零');
  const settleAgain = teamService.settleA10Pool();
  assert.equal(settleAgain.settled, false, '重复日结：池空不再发放');
  const v1Profile = teamService.profile(V1);
  assert.ok(v1Profile.byKind.a10_pool_share, 'V1 收益明细含 a10_pool_share');
  pass('A10 池：手续费 50% 实时入池，日结均分后清零，幂等');

  // ════════════════ 六、团队 profile 汇总 ════════════════
  console.log('六、团队 profile 汇总');
  const u3Profile = teamService.profile(U3);
  assert.equal(u3Profile.levelLabel, '未达标', '下级质押赎回后不沿用 A2 快照');
  assert.equal(u3Profile.directReferrer, U2, '直推上线正确');
  assert.equal(u3Profile.indirectReferrer, U1, '间推上线正确');
  assert.ok(Number(u3Profile.byKind.miner_direct || '0') > 0, 'U3 有直推分润收益');
  const u1Profile = teamService.profile(U1);
  assert.equal(u1Profile.levelLabel, '未达标', '不展示赎回前的旧级别');
  assert.ok(Number(u1Profile.byKind.miner_level_diff || '0') > 0, 'U1 有级差收益');

  // 团队质押业绩：直推/间推下级在押（active）质押本金汇总
  stakingService.stake(U3, 's30', '1000'); // U3 再质押定期 1000 AIX（推荐链 U3→U2→U1）
  const u2StakeProfile = teamService.profile(U2);
  assert.ok(Number(u2StakeProfile.directStakeA) >= 1000, 'U2 直推质押业绩含 U3 在押 1000 AIX');
  assert.ok(u2StakeProfile.directStakeUsers >= 1, '直推质押人数 ≥ 1');
  const u1StakeProfile = teamService.profile(U1);
  assert.ok(Number(u1StakeProfile.teamStakeA) >= 1000, 'U1 团队质押业绩含间接下级 U3 在押 1000 AIX');
  assert.ok(u1StakeProfile.teamStakeUsers >= 1, '团队质押人数 ≥ 1');
  pass('profile：等级/上下级/分润明细/团队质押业绩汇总正确');

  console.log('\na-token-ecosystem tests passed — 矿机/分润/质押/交易/互转/A10 池全部通过');
} finally {
  try { closeDatabase(dataRoot); } catch {}
  try { fs.rmSync(dataRoot, { recursive:true, force:true }); } catch {}
}
