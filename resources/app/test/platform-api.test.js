import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlatformApi } from '../src/platform-api.js';
import { createPlatformService } from '../src/platform-service.js';
import { closeDatabase } from '../src/database.js';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-platform-api-test-'));
const address = '0x0000000000000000000000000000000000000011';
const key = address.toLowerCase();
const balances = new Map([[key, 10_000_000000n]]);
const walletService = {
  balanceUnits(owner) { return balances.get(owner.toLowerCase()) || 0n; },
  debitBalance(owner, _asset, value) {
    const ownerKey = owner.toLowerCase();
    const amount = BigInt(value);
    const current = balances.get(ownerKey) || 0n;
    if (amount > current) throw new Error('平台账户余额不足');
    balances.set(ownerKey, current - amount);
  },
  creditBalance(owner, _asset, value) {
    const ownerKey = owner.toLowerCase();
    balances.set(ownerKey, (balances.get(ownerKey) || 0n) + BigInt(value));
  },
};

try {
  let fetchCount = 0;
  const platformService = createPlatformService({ dataRoot, walletService });
  const api = createPlatformApi({
    platformService,
    fetchPrices:async symbols => {
      fetchCount += 1;
      return new Map([[symbols[0], 60_000]]);
    },
    send() {},
    readBody:async () => ({}),
    getSession:() => null,
  });

  const payload = { symbol:'BTC', product:'spot', type:'market', side:'buy', size:'0.001', leverage:1, limitPrice:'' };
  const first = await api.executeOrder(address, payload, 'client_order_0001');
  const balanceAfterFirst = balances.get(key);
  const reloadedService = createPlatformService({ dataRoot, walletService });
  const reloadedApi = createPlatformApi({
    platformService:reloadedService,
    fetchPrices:async symbols => new Map([[symbols[0], 60_000]]),
    send() {}, readBody:async () => ({}), getSession:() => null,
  });
  const replay = await reloadedApi.executeOrder(address, payload, 'client_order_0001');
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.fill.id, first.fill.id);
  assert.equal(balances.get(key), balanceAfterFirst, '重试同一请求不能重复扣款');
  assert.equal(reloadedService.profile(address, 60_000).fills.length, 1);

  await assert.rejects(
    () => api.executeOrder(address, { ...payload, size:'0.002' }, 'client_order_0001'),
    error => error.code === 'IDEMPOTENCY_CONFLICT' && error.statusCode === 409,
  );
  await assert.rejects(
    () => api.executeOrder(address, { ...payload, product:'unknown' }, 'client_order_0003'),
    error => error.code === 'VALIDATION_ERROR' && /交易产品/.test(error.message),
  );
  await assert.rejects(
    () => api.executeOrder(address, { ...payload, type:'limit', limitPrice:'' }, 'client_order_0004'),
    error => error.code === 'VALIDATION_ERROR' && /限价/.test(error.message),
  );

  api.updateMarket({ symbol:'BTC', price:61_000, receivedAt:Date.now() });
  const newer = Date.now() + 1_000;
  api.updateMarket({ symbol:'BTC', price:62_000, receivedAt:newer });
  api.updateMarket({ symbol:'BTC', price:50_000, receivedAt:newer - 1 });
  assert.equal(await api.marketPrice('perp', 'BTC'), 62_000, '旧行情更新不能覆盖新标记价格');
  const perp = await api.executeOrder(address, { symbol:'BTC', product:'perp', type:'market', side:'buy', size:'0.001', leverage:10 }, 'client_order_0002');
  assert.equal(perp.price, 62_000);
  assert.equal(fetchCount, 1, '新鲜 WebSocket 行情应避免额外 REST 请求');
  api.updateMarket({ product:'perp', symbol:'BTC', price:62_000.123456789, receivedAt:newer + 1_000 });
  const precisePerp = await api.executeOrder(address, { symbol:'BTC', product:'perp', type:'market', side:'buy', size:'0.001', leverage:10 }, 'client_order_precise');
  assert.equal(precisePerp.price, 62_000.12, '外部行情成交价必须规范到小数点后两位');
  const maxLeveragePerp = await api.executeOrder(address, { symbol:'ETH', product:'perp', type:'market', side:'buy', size:'0.001', leverage:100 }, 'client_order_100x');
  assert.equal(maxLeveragePerp.fill.product, 'perp', 'API 应允许 100x 合约订单');
  await assert.rejects(
    () => api.executeOrder(address, { symbol:'ETH', product:'perp', type:'market', side:'buy', size:'0.001', leverage:101 }, 'client_order_101x'),
    error => error.code === 'VALIDATION_ERROR' && /1 到 100/.test(error.message),
  );
  const triggerOrder = await api.executeOrder(address, { symbol:'BTC', product:'spot', type:'trigger', side:'buy', size:'0.001', leverage:1, triggerPrice:'63000', triggerDirection:'above' }, 'client_trigger_order');
  assert.equal(triggerOrder.order.type, 'trigger');
  api.updateMarket({ product:'perp', symbol:'ETH', price:59_000, receivedAt:Date.now() - 6_000 });
  assert.equal(await api.marketPrice('perp', 'ETH', { allowStale:true }), 60_000, '过期行情应优先刷新 REST 价格');
  assert.equal(fetchCount, 2);
  const processedMarks = [];
  const restRiskApi = createPlatformApi({
    platformService:{ processMarkPrice:(...args) => processedMarks.push(args) },
    fetchPrices:async () => new Map([['BTCUSDT', 55_000]]),
    send() {}, readBody:async () => ({}), getSession:() => null,
  });
  assert.equal(await restRiskApi.marketPrice('perp', 'BTC'), 55_000);
  assert.deepEqual(processedMarks, [['perp', 'BTC', 55_000]], 'REST 标记价也必须进入强平风控');
  console.log('platform-api tests passed');
} finally {
  closeDatabase(dataRoot);
  fs.rmSync(dataRoot, { recursive:true, force:true });
}
