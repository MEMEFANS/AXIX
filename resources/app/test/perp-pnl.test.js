import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlatformService } from '../src/platform-service.js';
import { closeDatabase } from '../src/database.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-perp-pnl-test-'));
const address = '0x0000000000000000000000000000000000000007';
let balance = 100_000_000000n;
const walletService = {
  balanceUnits:() => balance,
  debitBalance:(_address, _asset, amount) => { balance -= BigInt(amount); },
  creditBalance:(_address, _asset, amount) => { balance += BigInt(amount); },
};

try {
  const platform = createPlatformService({ dataRoot:root, walletService });
  platform.perpTrade(address, { symbol:'BTC', side:'buy', size:'1', price:'60000', leverage:5, clientOrderId:'pnl_open_long', requestHash:'long-open' });
  let profile = platform.profile(address, { BTC:65_000 }, 'BTC');
  assert.equal(profile.perp.markPrice, '65000.0');
  assert.equal(profile.perp.unrealizedPnl, '5000.0');
  assert.equal(profile.perp.realizedPnl, '0.0');
  platform.perpTrade(address, { symbol:'BTC', side:'sell', size:'0.4', price:'65000', leverage:5, reduceOnly:true, clientOrderId:'pnl_partial_long', requestHash:'long-partial' });
  profile = platform.profile(address, { BTC:65_000 }, 'BTC');
  assert.equal(profile.perp.size, '0.6');
  assert.equal(profile.perp.realizedPnl, '2000.0');
  assert.equal(profile.fills[0].pnl, '2000.0');
  platform.perpTrade(address, { symbol:'BTC', side:'sell', size:'0.6', price:'65000', leverage:5, reduceOnly:true, clientOrderId:'pnl_close_long', requestHash:'long-close' });
  platform.perpTrade(address, { symbol:'BTC', side:'sell', size:'1', price:'64000', leverage:5, clientOrderId:'pnl_open_short', requestHash:'short-open' });
  profile = platform.profile(address, { BTC:60_000 }, 'BTC');
  assert.equal(profile.perp.size, '-1.0');
  assert.equal(profile.perp.unrealizedPnl, '4000.0');
  platform.perpTrade(address, { symbol:'BTC', side:'buy', size:'1', price:'60000', leverage:5, reduceOnly:true, clientOrderId:'pnl_close_short', requestHash:'short-close' });
  profile = platform.profile(address, { BTC:60_000 }, 'BTC');
  assert.equal(profile.perp.size, '0.0');
  assert.equal(profile.perp.realizedPnl, '9000.0');
  assert.ok(Number(profile.account.totalEquity) > 100_000, '已实现盈亏应进入账户权益');

  platform.perpTrade(address, { symbol:'BTC', side:'buy', size:'0.1', price:'60000', leverage:5, clientOrderId:'pnl_leverage_open', requestHash:'leverage-open' });
  platform.perpTrade(address, { symbol:'BTC', side:'buy', size:'0.1', price:'60000', leverage:20, clientOrderId:'pnl_leverage_add', requestHash:'leverage-add' });
  profile = platform.profile(address, { BTC:60_000 }, 'BTC');
  assert.equal(profile.perp.leverage, 5, '同方向加仓必须保持现有持仓杠杆');
  assert.equal(profile.perp.margin, '2400.0');
  platform.perpTrade(address, { symbol:'BTC', side:'sell', size:'0.1', price:'60000', leverage:20, reduceOnly:true, clientOrderId:'pnl_leverage_reduce', requestHash:'leverage-reduce' });
  profile = platform.profile(address, { BTC:60_000 }, 'BTC');
  assert.equal(profile.perp.leverage, 5, '减仓不能修改剩余持仓杠杆');
  assert.equal(profile.perp.margin, '1200.0');

  platform.perpTrade(address, { symbol:'ETH', side:'buy', size:'1', price:'3000', leverage:100, clientOrderId:'pnl_100x_open', requestHash:'100x-open' });
  profile = platform.profile(address, { BTC:60_000, ETH:3_000 }, 'ETH');
  assert.equal(profile.perps.ETH.leverage, 100, '合约应支持 100x 杠杆');
  assert.equal(profile.perps.ETH.margin, '30.0', '100x 仓位应按名义价值的 1% 计算开仓保证金');
  platform.perpTrade(address, { symbol:'BNB', side:'buy', size:'1', price:'600', leverage:150, clientOrderId:'pnl_leverage_cap', requestHash:'leverage-cap' });
  profile = platform.profile(address, { BTC:60_000, ETH:3_000, BNB:600 }, 'BNB');
  assert.equal(profile.perps.BNB.leverage, 100, '超过上限的杠杆必须限制为 100x');
  console.log('perp pnl tests passed');
} finally {
  closeDatabase(root);
  fs.rmSync(root, { recursive:true, force:true });
}
