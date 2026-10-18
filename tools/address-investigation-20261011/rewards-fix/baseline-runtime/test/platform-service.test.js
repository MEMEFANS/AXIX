import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlatformService } from '../src/platform-service.js';
import { closeDatabase } from '../src/database.js';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-platform-test-'));
const address = '0x0000000000000000000000000000000000000001';
const key = address.toLowerCase();
const balances = new Map([[key, 10_000_000000n]]);
const walletService = {
  balanceUnits(owner) {
    return balances.get(owner.toLowerCase()) || 0n;
  },
  debitBalance(owner, _asset, units) {
    const current = balances.get(owner.toLowerCase()) || 0n;
    const amount = BigInt(units);
    if (current < amount) throw new Error('平台账户余额不足');
    balances.set(owner.toLowerCase(), current - amount);
  },
  creditBalance(owner, _asset, units) {
    const ownerKey = owner.toLowerCase();
    balances.set(ownerKey, (balances.get(ownerKey) || 0n) + BigInt(units));
  },
};

try {
  const platform = createPlatformService({ dataRoot, walletService });
  platform.spotTrade(address, { side:'buy', size:'0.01', price:'60000' });
  platform.perpTrade(address, { side:'buy', size:'0.02', price:'60000', leverage:5 });
  platform.perpTrade(address, { side:'sell', size:'0.02', price:'61000', leverage:5 });
  platform.stake(address, '100');
  platform.unstake(address, '40');
  // 注入 AI 跟单策略（风云榜只统计跟单收益/本金，需有 ai-managed 策略才上榜）
  platform.addToInternalStrategy(address, 'ai-managed', {
    capitalUnits:'60000000', cashUnits:'60000000', inventoryUnits:'0',
    realizedPnlUnits:'20000000', totalEarnedUnits:'20000000',
    lastPriceUnits:'0', badDebtUnits:'0',
    batches:[{ id:'b1', principalUnits:'60000000', status:'active', startedAt:Date.now()-86400000, expiresAt:Date.now()+86400000*29, dayStartAt:Date.now(), dayEarnedUnits:'20000000' }],
    records:[{ slotAt:Date.now(), notionalUnits:'2420000000' }],
  }, '60000000');

  const profile = platform.profile(address, 61_000);
  assert.equal(profile.spot.BTC, '0.01');
  assert.equal(profile.spotFrozen.BTC, '0.0');
  assert.equal(profile.perp.size, '0.0');
  assert.equal(profile.perp.realizedPnl, '20.0');
  assert.equal(profile.staking.principal, '60.0');
  assert.equal(profile.fills.length, 3);
  assert.equal(profile.orderHistory.length, 3, '市价成交必须出现在历史委托');
  assert.ok(profile.orderHistory.every(order => order.type === 'market' && order.status === 'filled'));
  const leaderboard = platform.earningsLeaderboard({ address, markPrices:{ BTC:61_000 } });
  assert.equal(leaderboard.total, 1, '风云榜只统计有跟单收益的用户');
  assert.equal(leaderboard.items[0].address, address);
  assert.equal(leaderboard.items[0].earned, '20.0', '风云榜累计收益 = 跟单收益');
  assert.equal(leaderboard.items[0].earned30d, '20.0', '风云榜 30D 收益 = 跟单收益');
  assert.equal(leaderboard.items[0].roi30d, '33.33', '风云榜 ROI = 跟单收益/跟单本金');
  assert.equal(leaderboard.items[0].volume30d, '2420.0', '风云榜交易量 = 跟单模拟合约名义价值');
  assert.equal(leaderboard.items[0].isCurrent, true);
  assert.equal(profile.account.availableMargin, '9298.732');
  assert.ok(Number(profile.account.totalEquity) > Number(profile.account.availableMargin));
  assert.equal(balances.get(key), 9_298_732000n);

  platform.spotTrade(address, { symbol:'ETH', side:'buy', size:'0.1', price:'3000' });
  platform.perpTrade(address, { symbol:'ETH', side:'buy', size:'0.2', price:'3000', leverage:5 });
  const multiAssetProfile = platform.profile(address, { BTC:61_000, ETH:3_000 }, 'ETH');
  assert.equal(multiAssetProfile.spot.BTC, '0.01');
  assert.equal(multiAssetProfile.spot.ETH, '0.1');
  assert.equal(multiAssetProfile.perps.BTC.size, '0.0');
  assert.equal(multiAssetProfile.perps.ETH.size, '0.2');

  assert.throws(
    () => platform.spotTrade(address, { side:'sell', size:'1', price:'60000' }),
    /BTC 现货余额不足/,
  );

  const emptyAddress = '0x0000000000000000000000000000000000000002';
  const riskBeforeRejectedTrade = platform.profile(emptyAddress, 60_000).risk;
  assert.throws(
    () => platform.spotTrade(emptyAddress, { side:'buy', size:'1', price:'60000' }),
    /平台账户余额不足/,
  );
  assert.throws(
    () => platform.perpTrade(emptyAddress, { side:'buy', size:'1', price:'60000', leverage:20 }),
    /平台账户余额不足/,
  );
  const rejectedTradeProfile = platform.profile(emptyAddress, 60_000);
  assert.deepEqual(rejectedTradeProfile.risk, riskBeforeRejectedTrade, '余额不足不能改变保险基金或坏账');
  assert.equal(rejectedTradeProfile.perp.size, '0.0');
  assert.equal(rejectedTradeProfile.fills.length, 0);

  const partialAddress = '0x0000000000000000000000000000000000000003';
  const partialKey = partialAddress.toLowerCase();
  balances.set(partialKey, 1_000_000000n);
  platform.perpTrade(partialAddress, { side:'buy', size:'0.02', price:'60000', leverage:10 });
  platform.perpTrade(partialAddress, { side:'sell', size:'0.01', price:'50000', leverage:10 });
  const partialProfile = platform.profile(partialAddress, 50_000);
  assert.equal(partialProfile.perp.size, '0.01');
  assert.equal(partialProfile.perp.margin, '19.8', '部分平仓亏损应先消耗剩余仓位保证金');
  assert.equal(partialProfile.risk.badDebt, riskBeforeRejectedTrade.badDebt, '仓位仍有保证金时不能产生坏账');

  const beforeLimit = balances.get(key);
  const equityBeforeLimit = platform.profile(address, 61_000).account.totalEquity;
  const order = platform.placeOrder(address, { product:'spot', side:'buy', size:'0.001', limitPrice:'50000' }, 61_000);
  const limitProfile = platform.profile(address, 61_000);
  assert.equal(limitProfile.orders.length, 1);
  assert.equal(limitProfile.account.reservedUsdt, '50.025');
  assert.equal(limitProfile.account.strategyValue, '0.0');
  assert.equal(limitProfile.account.totalEquity, equityBeforeLimit, '冻结限价单资金不能降低账户总权益');
  assert.ok(balances.get(key) < beforeLimit, '限价买单应冻结 USDT');
  platform.cancelOrder(address, order.id);
  assert.equal(balances.get(key), beforeLimit, '撤单应归还冻结 USDT');
  const cancelledHistory = platform.profile(address, 61_000).orderHistory.find(item => item.id === order.id);
  assert.equal(cancelledHistory?.type, 'limit');
  assert.equal(cancelledHistory?.status, 'cancelled');

  const triggerAddress = '0x0000000000000000000000000000000000000008';
  balances.set(triggerAddress.toLowerCase(), 1_000_000000n);
  const triggerOrder = platform.placeOrder(triggerAddress, { product:'spot', type:'trigger', side:'buy', size:'0.001', triggerPrice:'62000', triggerDirection:'above' }, 60_000);
  assert.equal(platform.profile(triggerAddress, 60_000).orders[0].type, 'trigger');
  platform.processMarkPrice('spot', 'BTC', 61_000);
  assert.equal(platform.profile(triggerAddress, 61_000).orders.length, 1, '未达触发价时条件单必须保持待触发');
  platform.processMarkPrice('spot', 'BTC', 62_100);
  const triggeredProfile = platform.profile(triggerAddress, 62_100);
  assert.equal(triggeredProfile.orders.length, 0);
  assert.equal(triggeredProfile.spot.BTC, '0.001');
  assert.equal(triggeredProfile.orderHistory.find(item => item.id === triggerOrder.id)?.type, 'trigger');

  platform.placeOrder(address, { product:'spot', side:'buy', size:'0.001', limitPrice:'60000' }, 61_000);
  platform.processMarkPrice('spot', 59_000);
  assert.equal(platform.profile(address, 59_000).orders.length, 0);
  assert.equal(platform.profile(address, 59_000).spot.BTC, '0.011');

  platform.perpTrade(address, { side:'buy', size:'0.01', price:'60000', leverage:20 });
  platform.processMarkPrice('perp', 55_000);
  const liquidated = platform.profile(address, 55_000);
  assert.equal(liquidated.perp.size, '0.0');
  assert.ok(liquidated.fills.some(fill => fill.liquidation), '跌破维持保证金后应生成强平成交');
  assert.ok(Number(liquidated.risk.insuranceFund) >= 0, '保险基金不能为负数');
  assert.ok(Number(liquidated.risk.badDebt) >= 0, '超出保险基金的缺口应单独记录为坏账');

  const crossAddress = '0x0000000000000000000000000000000000000007';
  const crossKey = crossAddress.toLowerCase();
  balances.set(crossKey, 2_000_000000n);
  platform.perpTrade(crossAddress, { side:'buy', size:'0.1', price:'60000', leverage:20, marginMode:'cross' });
  const crossBeforeLiquidation = balances.get(crossKey);
  assert.equal(platform.profile(crossAddress, 60_000).perp.marginMode, 'cross');
  platform.processMarkPrice('perp', 50_000);
  assert.ok(balances.get(crossKey) < crossBeforeLiquidation, '全仓强平应优先使用钱包可用余额补充保证金');

  const closeAddress = '0x0000000000000000000000000000000000000004';
  const closeKey = closeAddress.toLowerCase();
  balances.set(closeKey, 2_000_000000n);
  platform.perpTrade(closeAddress, { side:'buy', size:'0.1', price:'60000', leverage:10 });
  const closeBalanceBefore = balances.get(closeKey);
  const closeOrder = platform.placeOrder(closeAddress, { product:'perp', side:'sell', size:'0.1', limitPrice:'61000', leverage:10 }, 60_000);
  assert.equal(balances.get(closeKey), closeBalanceBefore, '纯平仓限价单不应额外冻结手续费');
  platform.processMarkPrice('perp', 61_000);
  assert.equal(platform.profile(closeAddress, 61_000).orders.length, 0);
  assert.ok(balances.get(closeKey) > closeBalanceBefore, '平仓应释放保证金和盈亏');
  assert.equal(closeOrder.status, 'filled');

  const reduceAddress = '0x0000000000000000000000000000000000000005';
  const reduceKey = reduceAddress.toLowerCase();
  balances.set(reduceKey, 2_000_000000n);
  assert.throws(
    () => platform.perpTrade(reduceAddress, { side:'sell', size:'0.01', price:'60000', leverage:5, reduceOnly:true }),
    /只减仓订单/,
  );
  platform.perpTrade(reduceAddress, { side:'buy', size:'0.02', price:'60000', leverage:5 });
  assert.throws(
    () => platform.perpTrade(reduceAddress, { side:'buy', size:'0.01', price:'60000', leverage:5, reduceOnly:true }),
    /只减仓订单/,
  );
  const reduceOrder = platform.placeOrder(reduceAddress, { product:'perp', side:'sell', size:'0.015', limitPrice:'62000', leverage:5, reduceOnly:true }, 60_000);
  assert.equal(reduceOrder.reduceOnly, true);
  assert.throws(
    () => platform.placeOrder(reduceAddress, { product:'perp', side:'sell', size:'0.01', limitPrice:'63000', leverage:5, reduceOnly:true }, 60_000),
    /只减仓委托总量超过当前持仓/,
  );
  platform.cancelOrder(reduceAddress, reduceOrder.id);
  platform.perpTrade(reduceAddress, { side:'sell', size:'0.02', price:'61000', leverage:5, reduceOnly:true });
  assert.equal(platform.profile(reduceAddress, 61_000).perp.size, '0.0');

  const deficitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-platform-deficit-test-'));
  const deficitAddress = '0x0000000000000000000000000000000000000006';
  const deficitBalances = new Map([[deficitAddress.toLowerCase(), 2_000_000000n]]);
  const deficitWallet = {
    balanceUnits: owner => deficitBalances.get(owner.toLowerCase()) || 0n,
    debitBalance(owner, _asset, amount) { deficitBalances.set(owner.toLowerCase(), (deficitBalances.get(owner.toLowerCase()) || 0n) - BigInt(amount)); },
    creditBalance(owner, _asset, amount) { deficitBalances.set(owner.toLowerCase(), (deficitBalances.get(owner.toLowerCase()) || 0n) + BigInt(amount)); },
  };
  const deficitPlatform = createPlatformService({ dataRoot:deficitRoot, walletService:deficitWallet });
  deficitPlatform.perpTrade(deficitAddress, { side:'buy', size:'0.1', price:'60000', leverage:20 });
  deficitPlatform.perpTrade(deficitAddress, { side:'sell', size:'0.1', price:'50000', leverage:20 });
  assert.ok(Number(deficitPlatform.profile(deficitAddress, 50_000).risk.badDebt) > 0, '穿仓缺口不能被同一笔已无法收取的亏损冲销');
  closeDatabase(deficitRoot);
  fs.rmSync(deficitRoot, { recursive:true, force:true });

  const liquidationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-platform-liquidation-deficit-test-'));
  deficitBalances.set(deficitAddress.toLowerCase(), 2_000_000000n);
  const liquidationPlatform = createPlatformService({ dataRoot:liquidationRoot, walletService:deficitWallet });
  liquidationPlatform.perpTrade(deficitAddress, { side:'buy', size:'0.1', price:'60000', leverage:20 });
  liquidationPlatform.processMarkPrice('perp', 50_000);
  assert.ok(Number(liquidationPlatform.profile(deficitAddress, 50_000).risk.badDebt) > 0, '强平穿仓后必须保留坏账');
  closeDatabase(liquidationRoot);
  fs.rmSync(liquidationRoot, { recursive:true, force:true });

  const status = platform.systemStatus();
  assert.equal(status.settlement, 'internal');
  assert.ok(status.accounts >= 3);
  assert.ok(status.fills >= liquidated.fills.length);
  console.log('platform-service tests passed');
} finally {
  closeDatabase(dataRoot);
  fs.rmSync(dataRoot, { recursive:true, force:true });
}
