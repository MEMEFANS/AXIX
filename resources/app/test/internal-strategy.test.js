import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseUnits } from 'ethers';
import { createPlatformService } from '../src/platform-service.js';
import { createInternalStrategyService } from '../src/internal-strategy-service.js';
import { closeDatabase } from '../src/database.js';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-internal-strategy-test-'));
const walletA = '0x0000000000000000000000000000000000000011';
const walletB = '0x0000000000000000000000000000000000000022';
const balances = new Map([[walletA.toLowerCase(), 100_000_000n], [walletB.toLowerCase(), 100_000_000n]]);
const walletService = {
  balanceUnits(owner) { return balances.get(owner.toLowerCase()) || 0n; },
  debitBalance(owner, _asset, amount) {
    const key = owner.toLowerCase(), value = BigInt(amount), current = balances.get(key) || 0n;
    if (current < value) throw new Error('insufficient wallet balance');
    balances.set(key, current - value);
  },
  creditBalance(owner, _asset, amount) {
    const key = owner.toLowerCase();
    balances.set(key, (balances.get(key) || 0n) + BigInt(amount));
  },
};

try {
  const platform = createPlatformService({ dataRoot, walletService });
  const strategyMarkets = [
    { symbol:'BTC', priceDecimals:2, perp:true, enabled:true },
    { symbol:'ETH', priceDecimals:2, perp:true, enabled:true },
    { symbol:'SOL', priceDecimals:2, perp:true, enabled:true },
  ];
  const service = createInternalStrategyService({ platformService:platform, getMarkets:() => strategyMarkets, getMarkPrice:async () => 60_000 });
  assert.deepEqual(service.markets('de').map(item => item.symbol), ['BTC', 'ETH', 'SOL']);

  const started = await service.start(walletA, 'de', {
    mode:'neutral', lower:50_000, upper:70_000, gridCount:10, sizeBase:0.001, leverage:4, capital:40,
  });
  assert.equal(started.running, true);
  assert.equal(started.mode, 'internal');
  assert.equal(started.config.mode, 'neutral');
  assert.equal(balances.get(walletA.toLowerCase()), 60_000_000n);
  assert.equal(platform.profile(walletA, 60_000).strategy.balance, '0.0');

  const walletBState = service.stateFor(walletB, 'de', 60_000);
  assert.equal(walletBState.running, false);
  assert.equal(walletBState.capital, '0.0');
  assert.equal(walletBState.fills.length, 0);

  await service.processPrice('BTC', 63_000);
  const walletAFilled = service.stateFor(walletA, 'de', 63_000);
  assert.equal(walletAFilled.fills.length, 1);
  assert.equal(walletAFilled.fills[0].side, 'sell');
  assert.equal(walletAFilled.fills[0].kind, 'open');
  assert.equal(service.stateFor(walletB, 'de', 63_000).fills.length, 0);

  await service.processPrice('BTC', 65_000);
  await service.processPrice('BTC', 62_000);
  const partiallyClosed = service.stateFor(walletA, 'de', 62_000);
  assert.equal(partiallyClosed.fills[0].kind, 'close', '反向成交必须标记为平仓');
  assert.equal(partiallyClosed.fills[0].closing, true);
  assert.equal(partiallyClosed.position.entryPrice, 64_000, '部分平仓不能改写剩余持仓的入场价');
  assert.ok(partiallyClosed.fills[0].realizedPnl > 1.9 && partiallyClosed.fills[0].realizedPnl < 2, '本笔净盈亏应只包含已平仓价差和手续费');

  const stopped = await service.stop(walletA, 'de');
  assert.equal(stopped.running, false);
  assert.ok(Number(stopped.equity) > 0, '停止后应保留最终结算权益');
  assert.ok(Number(stopped.totalPnl) > -40, '停止后总盈亏不能因为状态清零而变成 -100%');
  assert.equal(
    balances.get(walletA.toLowerCase()),
    60_000_000n + parseUnits(stopped.equity, 6),
    '停止后最终权益必须回到平台可用余额',
  );
  assert.equal(platform.profile(walletA, 63_000).account.strategyValue, '0.0', '已停止策略不能继续占用账户资金');
  assert.equal(service.stateFor(walletA, 'de', 63_000).running, false);
  assert.equal(service.stateFor(walletA, 'de', 63_000).equity, stopped.equity);
  assert.equal(service.stateFor(walletB, 'de', 63_000).running, false);
  assert.equal(platform.profile(walletB, 63_000).strategy.balance, '0.0');
  assert.equal(platform.profile(walletB, 63_000).fills.length, 0);

  await assert.rejects(
    service.start(walletB, 'de', { mode:'invalid', lower:50_000, upper:70_000, gridCount:10, sizeBase:0.001, leverage:3, capital:1 }),
    /方向/,
  );

  const common = { lower:50_000, upper:70_000, gridCount:10, sizeBase:0.001, capital:10 };
  const balanceBeforeThreeStrategies = balances.get(walletA.toLowerCase());
  await service.start(walletA, 'de', { ...common, marketId:'BTC', mode:'long', leverage:250 });
  await service.start(walletA, 'ex', { ...common, marketId:'ETH', mode:'short', leverage:500 });
  await service.start(walletA, 'rs', { ...common, marketId:'SOL', mode:'neutral', leverage:1_000 });
  const all = service.allFor(walletA, 60_000);
  assert.equal(Object.values(all).filter(strategy => strategy.running).length, 3);
  assert.equal(all.de.config.mode, 'long');
  assert.equal(all.ex.config.mode, 'short');
  assert.equal(all.ex.config.symbol, 'ETH');
  assert.equal(all.rs.config.mode, 'neutral');
  assert.equal(all.rs.config.symbol, 'SOL');
  assert.equal(all.rs.config.leverage, 1_000);
  assert.equal(balanceBeforeThreeStrategies - balances.get(walletA.toLowerCase()), 30_000_000n, '三个策略应分别从平台 USDT 余额扣除投入金额');

  await service.processPrice('BTC', 63_000);
  assert.equal(service.stateFor(walletA, 'de', 63_000).fills.length, 0, '做多策略不应在没有多仓时向上突破开空');
  assert.equal(service.stateFor(walletA, 'ex', 63_000).fills.length, 0, '其他交易对行情不应触发 ETH 策略');
  await service.processPrice('ETHUSDT', 63_000);
  assert.equal(service.stateFor(walletA, 'ex', 63_000).fills[0].side, 'sell', '做空策略应在向上突破时开空');
  await service.processPrice('SOL', 63_000);
  assert.equal(service.stateFor(walletA, 'rs', 63_000).fills[0].side, 'sell', '中性策略应允许双向成交');

  await service.stop(walletA, 'de');
  await service.stop(walletA, 'ex');
  await service.stop(walletA, 'rs');
  console.log('internal-strategy tests passed');
} finally {
  closeDatabase(dataRoot);
  fs.rmSync(dataRoot, { recursive:true, force:true });
}
