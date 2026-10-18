import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { closeDatabase } from '../src/database.js';
import { createATokenService } from '../src/a-token-service.js';
import { createATokenTeamService } from '../src/a-token-team-service.js';
import { createATokenMinerService } from '../src/a-token-miner-service.js';
import { createReferralService } from '../src/referral-service.js';
import { createLotteryService } from '../src/lottery-service.js';
import { createATokenActivationService } from '../src/a-token-activation-service.js';

// ══════════════════════════════════════════════════════════════
// 链上收款对账（兜底漏单）离线测试：mock JSON-RPC 块扫描 + 注入校验 provider + 临时库
// 覆盖：首次初始化游标 → 补录链上漏单并自动确认发矿机 → 幂等 → 重复付款跳过
// ══════════════════════════════════════════════════════════════

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-reconcile-test-'));
const MAIN = '0x' + 'a7'.repeat(20);
const PAYER = Wallet.createRandom().address.toLowerCase();
const WEI_PLAN1 = 2n * 10n ** 15n;
const nowMs = 1_800_000_000_000;
const clock = () => nowMs;

const BLK = 1_000_000;
let LATEST = BLK + 500;                   // 当前链高
let TXS = [];                              // mock 链上返回的交易集合
const tx1 = '0x' + '1'.repeat(64);         // 第一笔（漏单，应补录）
const tx2 = '0x' + '2'.repeat(64);         // 同一钱包再付一笔（重复付款，应跳过）

// 对账扫描用的原始 JSON-RPC（服务内部用 fetch 调 rpcUrl）
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const handle = req => {
    const { method, params, id } = req;
    let result = null;
    if (method === 'eth_blockNumber') result = '0x' + LATEST.toString(16);
    else if (method === 'eth_getBlockByNumber') {
      const bn = parseInt(params?.[0], 16);
      result = {
        number: '0x' + bn.toString(16),
        timestamp: '0x' + Math.floor(nowMs / 1000).toString(16),
        transactions: TXS.map(t => ({ hash: t.hash, from: t.from, to: t.to, value: '0x' + t.value.toString(16) })),
      };
    }
    return { jsonrpc: '2.0', id, result };
  };
  const payload = Array.isArray(body) ? body.map(handle) : handle(body);
  return { ok: true, status: 200, json: async () => payload };
};

// 注入的链上校验 provider（避免 ethers 对 JSON-RPC 报文结构的强校验）
const paid = hash => TXS.some(t => t.hash === hash);
const fakeProvider = {
  async getTransaction(hash) {
    const t = TXS.find(t => t.hash === hash);
    return t ? { from: t.from, to: t.to, value: t.value } : null;
  },
  async getTransactionReceipt(hash) {
    return TXS.some(t => t.hash === hash) ? { status: 1, blockNumber: BLK } : null;
  },
  async getBlockNumber() { return LATEST; },
};

const pass = msg => console.log(`  ✓ ${msg}`);

try {
  const walletService = createWalletService({ dataRoot, depositAddress: MAIN, networks: [] });
  walletService.ensureUser(PAYER); // 激活记录外键依赖 wallet_users，先注册付款钱包
  const database = walletService.database;
  const at = createATokenService({ database, walletService });
  const teamService = createATokenTeamService({ database, walletService });
  const referralService = createReferralService({ database, walletService });
  const minerService = createATokenMinerService({ aTokenService: at, database, teamService, clock });
  const lotteryService = createLotteryService({ database, walletService, referralService });
  const svc = createATokenActivationService({
    aTokenService: at, minerService, database, clock,
    rpcUrl: 'http://mock-rpc.local', collectionAddress: MAIN, confirmations: 12,
    onConfirmed: (w, p) => lotteryService.onMinerActivated(w, p),
    reconcileLookbackBlocks: 501, // 使初始化游标 = LATEST-501 = BLK-1，下一轮从 BLK 开始扫
    providerOverride: fakeProvider,
  });

  TXS = [{ hash: tx1, from: PAYER, to: MAIN, value: WEI_PLAN1 }];

  // 第 1 轮：初始化游标，只回看设定起点，不扫描
  const r1 = await svc.reconcileNow();
  assert.equal(r1.initialized, true, '首次应初始化游标');
  assert.equal(database.getATokenActivationByTx(tx1), null, '首轮不应补录');
  pass(`首次初始化游标 block=${r1.cursor}`);

  // 第 2 轮：应扫描到链上付款 → 补建 pending → 走 verify → confirm（发矿机）
  const r2 = await svc.reconcileNow();
  assert.equal(r2.created, 1, `应补录 1 笔，实际 ${r2.created}`);
  const rec = database.getATokenActivationByTx(tx1);
  assert.ok(rec, '应生成激活记录');
  assert.equal(rec.status, 'confirmed', `激活记录应为 confirmed，实际 ${rec.status}`);
  assert.equal(String(rec.wallet).toLowerCase(), PAYER, '激活钱包应为付款方');
  assert.equal(rec.payload?.recovered, 'onchain-reconcile', '应标记为对账补录');
  assert.ok(database.listATokenMiners(PAYER).some(m => m.plan === 'mini120'), '应已发放 mini120 矿机');
  pass(`补录漏单并确认：status=${rec.status} plan=${rec.plan} 矿机已发放`);

  // 第 3 轮：游标已到链顶，无新增，幂等
  const r3 = await svc.reconcileNow();
  assert.equal(r3.created, 0, '不应重复补录');
  assert.equal(database.listATokenActivationsByWallet(PAYER).length, 1, '该钱包应仍只有 1 条激活记录');
  pass('幂等：不重复补录、不重复发矿机');

  // 第 4 轮：该钱包再付一笔 plan1（重复付款）→ 应识别并跳过，不补发
  LATEST = LATEST + 300;
  TXS = [
    { hash: tx1, from: PAYER, to: MAIN, value: WEI_PLAN1 },
    { hash: tx2, from: PAYER, to: MAIN, value: WEI_PLAN1 },
  ];
  const r4 = await svc.reconcileNow();
  assert.equal(r4.created, 0, '重复付款不应补录');
  assert.ok(r4.duplicate >= 1, `应识别到重复付款，实际 duplicate=${r4.duplicate}`);
  assert.equal(database.getATokenActivationByTx(tx2), null, '重复付款不应生成记录');
  assert.equal(database.listATokenActivationsByWallet(PAYER).length, 1, '该钱包仍应只有 1 条记录');
  pass(`重复付款识别并跳过：duplicate=${r4.duplicate}`);

  // 第 5 轮：金额不匹配套餐（0.001 BNB）不应命中
  LATEST = LATEST + 300;
  TXS = [{ hash: '0x' + '3'.repeat(64), from: PAYER, to: MAIN, value: 1n * 10n ** 15n }];
  const r5 = await svc.reconcileNow();
  assert.equal(r5.matched, 0, '金额不匹配套餐不应命中');
  pass('金额不匹配套餐不命中');

  // 第 6 轮：历史收款地址（EXTRA）——前端已提交但被驳回的旧地址付款，应自动恢复发矿机
  //   模拟：用户页面缓存了旧收款地址并付款 → 提交时服务端记录 expected=MAIN → verify 驳回
  //         → 对账扫描覆盖 EXTRA → 重新校验命中白名单 → confirm 发矿机
  const EXTRA = '0x' + 'b8'.repeat(20);
  const PAYER2 = Wallet.createRandom().address.toLowerCase();
  const tx3 = '0x' + '4'.repeat(64);
  walletService.ensureUser(PAYER2);
  const svc2 = createATokenActivationService({
    aTokenService: at, minerService, database, clock,
    rpcUrl: 'http://mock-rpc.local', collectionAddress: MAIN, confirmations: 12,
    extraCollectionAddresses: EXTRA,
    reconcileLookbackBlocks: 501,
    providerOverride: fakeProvider,
  });
  const pendingRec = svc.submit(PAYER2, '1', tx3); // 提交瞬间记录 expected=MAIN
  assert.equal(String(pendingRec.payload.collectionAddress).toLowerCase(), MAIN, '提交时记录的收款地址应为主地址');
  LATEST = LATEST + 300;
  TXS = [{ hash: tx3, from: PAYER2, to: EXTRA, value: WEI_PLAN1 }];
  const bad = await svc.verify(pendingRec);
  assert.equal(bad.status, 'rejected', '未配置该历史地址时应驳回');
  assert.equal(database.getATokenActivationByTx(tx3).payload.rejectReason, '收款地址不符', '驳回原因应为收款地址不符');
  pass('旧地址付款先被驳回（收款地址不符）');

  const r6 = await svc2.reconcileNow();
  // mock 让同一批 tx 出现在区间内每个区块（真实链上 tx 只属于一个区块），故这里只断言「至少恢复 1 笔」
  assert.ok(r6.recovered >= 1, `应恢复驳回记录，实际 ${r6.recovered}`);
  const rec3 = database.getATokenActivationByTx(tx3);
  assert.equal(rec3.status, 'confirmed', `恢复后应为 confirmed，实际 ${rec3.status}`);
  assert.ok(!rec3.payload?.rejectReason, '恢复后应清除驳回原因');
  assert.ok(database.listATokenMiners(PAYER2).some(m => m.plan === 'mini120'), '应已补发 mini120 矿机');
  pass(`历史地址白名单恢复并补发矿机：recovered=${r6.recovered}`);

  // ── 收款地址轮换：按套餐独立间隔 + 轮换地址白名单（确保矿机与积分照常发放）──
  const ROT1 = '0x943774988069297e3b51828ee08c2474cd72b35e'; // 0.002 套餐轮换地址
  const ROT2 = '0x31be041b05f285bd4458bcaf4b4adaa21a690511'; // 0.05 套餐轮换地址
  const rotCfg = {
    aTokenService: at, minerService, clock,
    rpcUrl: 'http://mock-rpc.local', collectionAddress: MAIN, confirmations: 12,
    rotationAddressesByPlan: `1:${ROT1},2:${ROT2}`,
    rotationPlan: '1,2', rotationEvery: 3, rotationEveryByPlan: '1:3,2:2',
    providerOverride: fakeProvider,
  };
  // 用可控计数的库桩推演地址序列，验证「每 N 笔的第 N 笔进轮换地址」
  let stubCount = 0;
  const svcSeq = createATokenActivationService({ ...rotCfg, database: { countConfirmedATokenActivationsByPlan: () => stubCount } });
  const pick = (plan, n) => {
    stubCount = n;
    return svcSeq.getCollectionAddressForPlan(plan).toLowerCase() === MAIN.toLowerCase() ? 'M' : 'R';
  };
  const seq1 = [0, 1, 2, 3, 4, 5].map(n => pick('1', n));
  const seq2 = [0, 1, 2, 3].map(n => pick('2', n));
  assert.deepEqual(seq1, ['M', 'M', 'R', 'M', 'M', 'R'], `0.002 应 3 进 1，实际 ${seq1.join('')}`);
  assert.deepEqual(seq2, ['M', 'R', 'M', 'R'], `0.05 应 2 进 1，实际 ${seq2.join('')}`);
  pass(`按套餐独立间隔：0.002=${seq1.join('')} · 0.05=${seq2.join('')}`);

  // 打到 0.002 轮换地址的付款：应通过校验，并照常发矿机 + 触发积分发放回调
  const PAYER3 = Wallet.createRandom().address.toLowerCase();
  walletService.ensureUser(PAYER3);
  const tx4 = '0x' + '6'.repeat(64);
  const credited = [];
  const svcRot = createATokenActivationService({ ...rotCfg, database, onConfirmed: (w, p) => credited.push(`${w}:${p}`) });
  const rotRec = svcRot.submit(PAYER3, '1', tx4);
  LATEST = LATEST + 300;
  TXS = [{ hash: tx4, from: PAYER3, to: ROT1, value: WEI_PLAN1 }];
  const vr = await svcRot.verify(rotRec);
  assert.equal(vr.status, 'confirmed', `打到轮换地址应确认，实际 ${vr.status}/${vr.reason || ''}`);
  assert.ok(database.listATokenMiners(PAYER3).some(m => m.plan === 'mini120'), '应发放 mini120 矿机');
  assert.equal(credited.length, 1, '应触发 1 次积分发放回调');
  pass(`轮换地址付款已确认并发矿机+积分：${credited[0]}`);

  console.log('a-token-reconcile.test.js PASS');
} finally {
  try { closeDatabase(dataRoot); } catch {}
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
