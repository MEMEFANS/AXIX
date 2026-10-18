import assert from 'node:assert/strict';
import { createAiManagedService } from '../src/ai-managed-service.js';

let now = 0;
const address = '0x0000000000000000000000000000000000000001';
const secondAddress = '0x0000000000000000000000000000000000000002';
const balances = new Map([[address, 2_000_000_000n], [secondAddress, 500_000_000n]]);
const strategies = new Map(), batches = new Map(), rewards = new Map();
const walletService = {
  balanceUnits:account => balances.get(account) || 0n,
  creditBalance(account, _asset, value) { balances.set(account, (balances.get(account) || 0n) + BigInt(value)); },
  // 新 wallet-ledger 模型：本金在 ai-managed start() 里直接从钱包扣除（策略层 updateInternalStrategy 只做簿记）
  debitBalance(account, _asset, value) { balances.set(account, (balances.get(account) || 0n) - BigInt(value)); },
};
const platformService = {
  database:{
    upsertAiBatch(item) { batches.set(item.id, structuredClone(item)); },
    insertAiReward(item) { if (!rewards.has(item.id)) rewards.set(item.id, structuredClone(item)); },
    aiRewardById(id) { return rewards.has(id) ? structuredClone(rewards.get(id)) : null; },
  },
  internalStrategyState:account => structuredClone(strategies.get(account) || null),
  internalStrategyAccounts:() => [...strategies.entries()].filter(([,item]) => item.running).map(([account]) => account),
  startInternalStrategy(account, _key, state, capital) {
    for (const field of ['capitalUnits','cashUnits','inventoryUnits','realizedPnlUnits','lastPriceUnits','badDebtUnits']) assert.match(String(state[field]), /^-?\d+$/, `missing ledger field ${field}`);
    assert.ok((balances.get(account) || 0n) >= capital); balances.set(account, balances.get(account) - capital); strategies.set(account, structuredClone(state));
  },
  addToInternalStrategy(account, _key, state, capital) {
    assert.ok((balances.get(account) || 0n) >= capital); balances.set(account, balances.get(account) - capital); strategies.set(account, structuredClone(state));
  },
  updateInternalStrategy(account, _key, state) { strategies.set(account, structuredClone(state)); },
};
const candles = Array.from({ length:100 }, (_, index) => ({ time:index * 1000, open:63000 + index, high:63010 + index, low:62990 + index, close:63005 + index, volume:1 }));
const service = createAiManagedService({ platformService, walletService, fetchCandles:async()=>candles, clock:()=>now, slotMs:1000, dayMs:20000, timezoneOffsetMs:0 });

// 跟单 VIP 会员制：测试预置已开通状态（销毁 100 AIX 的等效前提），有效期覆盖全部用例时间线
strategies.set(address, { copyTradeUnlockedAt: 1 });
strategies.set(secondAddress, { copyTradeUnlockedAt: 1 });

let state = await service.start(address, '1000', { termDays:180 });
assert.equal(state.principal, '1000.0');
assert.ok(state.batches[0].rateBps >= 50 && state.batches[0].rateBps <= 67, '日化收益必须落在月化 15%-20% 换算区间');
assert.equal(balances.get(address), 1_000_000_000n);

now = 2000; state = await service.stateFor(address);
const dailyTarget = 1000 * state.batches[0].rateBps / 10000;
assert.ok(Number(state.dayEarned) >= 0 && Number(state.dayEarned) <= dailyTarget, '日内入账不可超过每日目标（首笔若为亏损明细则不入账，dayEarned 可为 0）');
assert.equal(balances.get(address), 1_000_000_000n, '日内明细先累计，未达到当日目标前不入账');
assert.equal(state.records[0].direction, '多');
assert.ok('openPrice' in state.records[0] && 'closePrice' in state.records[0] && 'leverage' in state.records[0]);
assert.notEqual(state.records[0].openPrice, state.records[0].closePrice, '模拟合约的开仓价和平仓价不能相同');
assert.ok(Number(state.records[0].size) > 0.0001, '模拟仓位币量不能退化成无意义的小数');
const firstRecord = state.records[0];
const calculatedPnl = firstRecord.direction === '多'
  ? (firstRecord.closePrice - firstRecord.openPrice) * firstRecord.size
  : (firstRecord.openPrice - firstRecord.closePrice) * firstRecord.size;
assert.ok(Math.abs(calculatedPnl - Number(firstRecord.profit)) < 0.000001, '收益必须由开平价差和币量计算得出');
assert.ok(Math.abs(firstRecord.margin * firstRecord.leverage - firstRecord.notional) < 0.000001, '名义价值必须等于保证金乘以杠杆');
assert.ok(firstRecord.leverage >= 3 && firstRecord.leverage <= 10, 'AI 托管模拟杠杆必须保持在合理区间');
assert.ok(firstRecord.margin > 0 && Number.isFinite(firstRecord.margin), '历史 K 线计算出的保证金必须有效');

state = await service.start(address, '100', { termDays:30 });
assert.equal(state.batches.filter(item => item.status === 'active').length, 2, '追加资金应创建独立批次');
assert.ok(state.batches.every(item => item.planDays === 30), '统一 30 天锁仓计划');
assert.equal(state.principal, '1100.0');

now = 2000; state = await service.stateFor(address);
const expectedDayTargetUnits = state.batches.filter(item => item.status === 'active')
  .reduce((sum, item) => sum + BigInt(item.principalUnits) * BigInt(item.rateBps) / 10000n, 0n);
assert.ok(Math.abs(Number(state.dayTarget) - Number(expectedDayTargetUnits) / 1e6) < 1e-6, '日化目标应按各批次本金与日化费率汇总');
assert.equal(state.autoCompound, false);

now = 20000; state = await service.stateFor(address);
assert.ok(Math.abs(Number(state.dayEarned) - Number(expectedDayTargetUnits) / 1e6) < 1e-6, '每日最后一个明细必须补足设定日化收益');
assert.ok(new Set(state.records.map(item => item.profitUnits)).size > 2, '单笔模拟收益不应固定');
assert.deepEqual(new Set(state.records.map(item => item.symbol)), new Set(['BTCUSDT', 'ETHUSDT']), '执行明细应同时包含 BTC 和 ETH');
assert.ok(state.records.some((item, index, records) => index > 0 && item.symbol === records[index - 1].symbol), 'BTC 和 ETH 不能固定一单一单交替出现');
const firstBatchCount = state.records.filter(item => item.batchId === state.batches[0].id).length;
const secondBatchCount = state.records.filter(item => item.batchId === state.batches[1].id).length;
assert.ok(firstBatchCount >= 8 && firstBatchCount <= 35, '随机间隔(0.62~1.38 倍 slot 周期)下首批明细数应落在合理区间');
assert.ok(secondBatchCount >= 8 && secondBatchCount <= 35, '随机间隔下追加批次明细数应落在合理区间');
assert.equal(balances.get(address), 900_000_000n + expectedDayTargetUnits, '达到当日目标后，收益应从平台按日进入用户余额');

now = 610000; state = await service.stateFor(address);
assert.equal(state.batches.filter(item => item.status === 'active').length, 2, '30 天锁仓到期后仍在 10 年存续期内，批次应继续托管');
assert.equal(state.running, true);

state = await service.stopCopyTrade(address);
const balanceAtExitRequest = balances.get(address);
assert.equal(state.running, false);
assert.equal(state.batches.filter(item => item.status === 'exiting').length, 2, '停止跟单后批次进入「退出中」');
assert.equal(state.exitPending, true);
assert.ok(state.exitPayoutAt, '应返回预计到账时间');
assert.equal(balances.get(address), balanceAtExitRequest, '退出中本金尚未到账');

now += 24 * 60 * 60_000; state = await service.stateFor(address);
assert.equal(state.batches.filter(item => item.status === 'exited').length, 2, '满 24 小时后批次完成退出');
assert.equal(state.exitPending, false);
assert.equal(balances.get(address), balanceAtExitRequest + 1_100_000_000n, '退出满 24 小时后本金全额返还，不扣罚金');

const secondState = await service.start(secondAddress, '100', { termDays:360 });
assert.ok(secondState.batches[0].rateBps >= 50 && secondState.batches[0].rateBps <= 67, '新钱包日化同样落在随机月化区间');
assert.equal(strategies.get(address).running, false, '另一个钱包不能改变原钱包状态');
assert.equal(balances.get(secondAddress), 400_000_000n);
service.stop();
console.log('ai-managed tests passed');
