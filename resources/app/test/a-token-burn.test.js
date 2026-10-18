import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { closeDatabase } from '../src/database.js';
import { createATokenService, A_TOKEN_DECIMALS } from '../src/a-token-service.js';
import { createAiManagedService } from '../src/ai-managed-service.js';
import { MINER_PLANS } from '../src/a-token-miner-service.js';
import { ACTIVATION_PLANS } from '../src/a-token-activation-service.js';

const A = v => BigInt(v) * 10n ** BigInt(A_TOKEN_DECIMALS);
const U = v => BigInt(v) * 10n ** 6n;
const dayMs = 24 * 60 * 60_000;

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-atoken-burn-test-'));
try {
  const walletService = createWalletService({ dataRoot, depositAddress:`0x${'D0'.padStart(40, '0')}`, networks:[] });
  const aToken = createATokenService({ database: walletService.database, walletService });

  // ── 规则 3：0.002 BNB 激活包产出 90 → 100 枚 ──
  assert.equal(BigInt(MINER_PLANS.mini120.totalUnits), A(100), 'mini120 矿机总量应为 100 AIX');
  assert.match(ACTIVATION_PLANS['1'].label, /Mini 矿机/, '激活套餐文案应显示 Mini 矿机');
  assert.match(ACTIVATION_PLANS['2'].label, /Pro 矿机/, '激活套餐文案应显示 Pro 矿机');

  // ── 规则 1：当日销毁累计进 todayBurnedUnits ──
  assert.equal(aToken.burn(A(50), 'trade', '测试销毁'), A(50));
  let meta = aToken.getPoolMeta();
  assert.equal(BigInt(meta.todayBurnedUnits), A(50), '今日销毁应累计 50');

  // 销毁开关只控制「每日固定补足」：关闭时跨日只滚动日期、不补足（手续费/VIP 销毁不受影响）
  const yesterday = new Date(Date.now() - dayMs).toISOString().slice(0, 10);
  aToken.setPoolMeta({ burnDate: yesterday, todayBurnedUnits: A(100).toString() });
  aToken.settleDailyBurn();
  meta = aToken.getPoolMeta();
  assert.equal(meta.burnDate, new Date().toISOString().slice(0, 10), '结算日应翻到今天');
  assert.equal(BigInt(meta.todayBurnedUnits), 0n, '新的一天今日销毁应从 0 开始');
  assert.equal(BigInt(meta.totalBurnedUnits), A(50), '开关关闭时不应补足销毁');

  // 开启开关后：昨日仅销毁 100 枚 → 固定补足到 100 万（补 999,900）
  aToken.setPoolMeta({ burnEnabled: '1', burnDate: yesterday, todayBurnedUnits: A(100).toString() });
  aToken.settleDailyBurn();
  assert.equal(BigInt(aToken.getPoolMeta().totalBurnedUnits), A(50) + A(999_900), '应补足销毁 999,900 枚');

  // 幂等：当天再次结算不重复补足
  aToken.settleDailyBurn();
  assert.equal(BigInt(aToken.getPoolMeta().totalBurnedUnits), A(50) + A(999_900), '重复结算不能重复销毁');

  // 昨日已达标（120 万 > 100 万）→ 不再补足
  aToken.setPoolMeta({ burnDate: yesterday, todayBurnedUnits: A(1_200_000).toString() });
  const beforeSettle = BigInt(aToken.getPoolMeta().totalBurnedUnits);
  aToken.settleDailyBurn();
  assert.equal(BigInt(aToken.getPoolMeta().totalBurnedUnits), beforeSettle, '昨日销毁已达 100 万枚时不应再补足');

  // 新的一天销毁正常累计
  assert.equal(aToken.burn(A(10), 'trade', '测试销毁2'), A(10));
  assert.equal(BigInt(aToken.getPoolMeta().todayBurnedUnits), A(10), '今日销毁应累计 10');

  // poolStats 暴露今日销毁字段
  const stats = aToken.poolStats();
  assert.equal(stats.dailyBurnTarget, '1000000.0');
  assert.ok(Number(stats.todayBurnLeft) > 0 && Number(stats.todayBurnLeft) < 1_000_000, '今日剩余销毁目标应在 0~100 万之间');

  // ── 规则 2：首次开启合约跟单销毁 100 枚 AIX ──
  const strategies = new Map(), batches = new Map(), rewards = new Map();
  const platformService = {
    database: {
      upsertAiBatch: item => batches.set(item.id, structuredClone(item)),
      insertAiReward: item => { if (!rewards.has(item.id)) rewards.set(item.id, structuredClone(item)); },
      aiRewardById: id => rewards.has(id) ? rewards.get(id) : null,
    },
    internalStrategyState: account => structuredClone(strategies.get(account) || null),
    startInternalStrategy: (account, _key, state) => { strategies.set(account, structuredClone(state)); },
    addToInternalStrategy: (account, _key, state) => { strategies.set(account, structuredClone(state)); },
    updateInternalStrategy: (account, _key, state) => { strategies.set(account, structuredClone(state)); },
  };
  const ai = createAiManagedService({ platformService, walletService, fetchCandles: async () => [], aTokenService: aToken });

  // ── VIP 会员制：必须先 unlock() 销毁 100 AIX 开通 30 天 VIP，才能 start() 跟单 ──
  const user = Wallet.createRandom().address;
  walletService.creditBalance(user, 'USDT', U(5000));
  walletService.creditBalance(user, 'A', A(99));

  // 未开通 VIP：跟单被拒绝，且不扣 USDT
  await assert.rejects(async () => ai.start(user, '500'), /请先开通 VIP 跟单权益/);
  assert.equal(walletService.balanceUnits(user, 'USDT'), U(5000), '未开通 VIP 跟单不能扣 USDT 本金');

  // AIX 余额不足开通 VIP：友好报错，不扣任何款项
  await assert.rejects(async () => ai.unlock(user), /开通 VIP 跟单权益需销毁 100\.0 枚 AIX/);
  assert.equal(walletService.balanceUnits(user, 'USDT'), U(5000), '开通失败不能扣 USDT');
  assert.equal(walletService.balanceUnits(user, 'A'), A(99), '开通失败不能扣 AIX');

  // 补足 AIX，开通 VIP：销毁 100 枚，获得 30 天权益
  walletService.creditBalance(user, 'A', A(1));
  const burnedBefore = aToken.totalBurned();
  const vip = await ai.unlock(user);
  assert.equal(vip.copyTradeUnlocked, true, '开通后应标记为 VIP 有效');
  assert.equal(vip.unlockCostA, '100.0');
  assert.equal(vip.unlockDays, 30, 'VIP 权益应为 30 天');
  assert.equal(vip.unlockDaysLeft, 30, '刚开通剩余天数应为 30 天');
  assert.ok(vip.unlockExpiresAt, '应返回权益到期时间');
  assert.equal(walletService.balanceUnits(user, 'A'), 0n, '100 枚 AIX 应被销毁扣除');
  assert.equal(aToken.totalBurned() - burnedBefore, A(100), '销毁总额应增加 100 枚');

  // VIP 有效期内重复开通：拒绝且不销毁
  await assert.rejects(async () => ai.unlock(user), /VIP 跟单权益有效中/);
  assert.equal(aToken.totalBurned() - burnedBefore, A(100), '重复开通不能再销毁');

  // VIP 有效期内跟单：只扣 USDT 本金，不再销毁 AIX
  const pres = await ai.start(user, '500');
  assert.equal(pres.copyTradeUnlocked, true);
  assert.equal(walletService.balanceUnits(user, 'A'), 0n, '跟单不能扣 AIX');
  assert.equal(aToken.totalBurned() - burnedBefore, A(100), '跟单销毁总额不能增加');
  await ai.start(user, '500'); // 追加批次同样不销毁
  assert.equal(aToken.totalBurned() - burnedBefore, A(100), '追加批次不能销毁 AIX');

  // VIP 到期（31 天后）：状态失效，跟单被拒且不扣 USDT
  const expiredState = strategies.get(user);
  expiredState.copyTradeUnlockedAt = Date.now() - 31 * dayMs;
  strategies.set(user, expiredState);
  const expiredView = await ai.stateFor(user);
  assert.equal(expiredView.copyTradeUnlocked, false, '到期后 VIP 应失效');
  assert.ok(expiredView.unlockExpiresAt, '到期后仍应返回到期时间');
  const usdtBeforeRenew = walletService.balanceUnits(user, 'USDT');
  await assert.rejects(async () => ai.start(user, '100'), /请先开通 VIP 跟单权益/);
  assert.equal(walletService.balanceUnits(user, 'USDT'), usdtBeforeRenew, '到期后跟单不能扣 USDT 本金');

  // 续费：余额不足友好报错；补足后 unlock 重新销毁 100 枚、恢复 30 天，跟单不再销毁
  await assert.rejects(async () => ai.unlock(user), /续费 VIP 跟单权益需销毁 100\.0 枚 AIX/);
  walletService.creditBalance(user, 'A', A(100));
  const burnedBeforeRenew = aToken.totalBurned();
  const renewRes = await ai.unlock(user);
  assert.equal(renewRes.copyTradeUnlocked, true, '续费后 VIP 应恢复有效');
  assert.equal(renewRes.unlockDaysLeft, 30, '续费后应重新获得 30 天');
  assert.equal(walletService.balanceUnits(user, 'A'), 0n, '续费应销毁 100 枚 AIX');
  assert.equal(aToken.totalBurned() - burnedBeforeRenew, A(100), '续费销毁总额应再增加 100 枚');
  assert.equal(aToken.totalBurned() - burnedBefore, A(200), '首开+续费累计应销毁 200 枚');
  await ai.start(user, '100');
  assert.equal(aToken.totalBurned() - burnedBefore, A(200), '续费后跟单不能再销毁 AIX');

  // 老用户兼容：上线前已有跟单批次的钱包首次跟单赠送 30 天 VIP，不销毁
  const old = Wallet.createRandom().address;
  walletService.creditBalance(old, 'USDT', U(5000));
  walletService.creditBalance(old, 'A', A(50));
  strategies.set(old, {
    key:'ai-managed', name:'AI 托管策略', running:false, autoCompound:false,
    batches:[{ id:'aib_legacy_1', wallet:old, principalUnits:U(100).toString(), status:'redeemed',
      planDays:30, rateBps:73, startedAt:Date.now() - 40 * dayMs, expiresAt:Date.now() - 10 * dayMs,
      dayStartAt:0, dayEarnedUnits:'0', totalEarnedUnits:'0', daySlotTarget:20, lastSlotAt:Date.now() - 10 * dayMs }],
    records:[], totalEarnedUnits:'0', lastSlotAt:Date.now(), startedAt:new Date().toISOString(),
    capitalUnits:'0', cashUnits:'0', inventoryUnits:'0', realizedPnlUnits:'0', lastPriceUnits:'0', badDebtUnits:'0',
    config:{ slotMinutes:72, plans:{} },
  });
  const oldRes = await ai.start(old, '300');
  assert.equal(oldRes.copyTradeUnlocked, true, '老用户首次跟单应赠送 VIP');
  assert.equal(walletService.balanceUnits(old, 'A'), A(50), '老用户赠送 VIP 不能扣 AIX');

  // 老用户赠送的 VIP 到期后：跟单被拒，必须 unlock 销毁 100 枚续费
  const oldExpired = strategies.get(old);
  oldExpired.copyTradeUnlockedAt = Date.now() - 31 * dayMs;
  strategies.set(old, oldExpired);
  await assert.rejects(async () => ai.start(old, '100'), /请先开通 VIP 跟单权益/);
  const oldBurnedBefore = aToken.totalBurned();
  await assert.rejects(async () => ai.unlock(old), /续费 VIP 跟单权益需销毁 100\.0 枚 AIX/);
  walletService.creditBalance(old, 'A', A(50));
  const oldRenew = await ai.unlock(old);
  assert.equal(oldRenew.copyTradeUnlocked, true, '老用户续费后 VIP 恢复');
  assert.equal(walletService.balanceUnits(old, 'A'), 0n, '老用户续费应销毁 100 枚 AIX');
  assert.equal(aToken.totalBurned() - oldBurnedBefore, A(100), '老用户续费销毁总额应增加 100 枚');

  ai.stop();
  closeDatabase(dataRoot);
  console.log('a-token-burn tests passed');
} finally {
  fs.rmSync(dataRoot, { recursive:true, force:true });
}
