// AIX 商城 API 集成测试（2026-10-30）：
//   开店/上架/改价/上下架 → 买家地址管理 → 下单支付（扣款/入账/扣库存）
//   → 取消退款回库存 → 商户发货 → 确认收货 → 边界（自购拦截/余额不足/
//   库存不足/未登录/越权）。使用真实 SQLite（临时目录）+ 内存账本 mock。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';
import { createMallApi } from '../src/mall-api.js';

const UNITS = 10n ** 18n;
const MERCHANT = '0xA11ce00000000000000000000000000000000001';
const BUYER = '0xB0b00000000000000000000000000000000000002';

// ── 测试脚手架：内存账本 + 请求/响应桩 ──
const ledger = new Map([[MERCHANT.toLowerCase(), 500n * UNITS], [BUYER.toLowerCase(), 1000n * UNITS]]);
const aTokenService = {
  balanceA: wallet => ledger.get(String(wallet).toLowerCase()) || 0n,
  creditA: (wallet, units) => {
    const amount = BigInt(units);
    if (amount <= 0n) throw new Error('入账金额不能为负数');
    ledger.set(String(wallet).toLowerCase(), (ledger.get(String(wallet).toLowerCase()) || 0n) + amount);
  },
  debitA: (wallet, units) => {
    const amount = BigInt(units);
    const key = String(wallet).toLowerCase();
    const current = ledger.get(key) || 0n;
    if (amount <= 0n) throw new Error('提现金额必须大于 0');
    if (current < amount) throw new Error('平台账户余额不足');
    ledger.set(key, current - amount);
  },
};
const wallets = new Set([MERCHANT, BUYER]);
const walletService = { isAccountBlocked: address => !wallets.has(address) };

let currentBody = {};
let currentSession = { address: BUYER };
let lastResponse = null;
const send = (res, code, data) => { lastResponse = { code, data }; res?.sent?.(code, data); };
const readBody = async () => currentBody;
const getSession = () => currentSession;
const withAccountLock = (address, op) => op();

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axix-mall-test-'));
const database = openDatabase(dataRoot);
// 商城表带 FOREIGN KEY(wallet) REFERENCES wallet_users(address)——生产中登录即建用户行，测试库手动补
{
  const insertUser = database.db.prepare(`INSERT INTO wallet_users(address, balances_json, created_at, updated_at, payload_json)
    VALUES(?,?,?,?,?)`);
  for (const wallet of [MERCHANT, BUYER]) {
    insertUser.run(wallet, '{}', Date.now(), Date.now(), '{}');
  }
}
const mallApi = createMallApi({ aTokenService, database, walletService, send, readBody, getSession, withAccountLock });

async function call(pathname, { method = 'POST', body = {}, session = { address: BUYER } } = {}) {
  currentBody = body; currentSession = session;
  const request = { method, url: pathname };
  lastResponse = null;
  await mallApi.handle(request, {}, pathname);
  // 与 server.js 真实 send 一致：send 无返回值（错误时 fall-through 由 headersSent 兜底），
  // 这里以"产生了响应"为准
  assert.ok(lastResponse, `${method} ${pathname} 应被商城路由处理`);
  return lastResponse;
}
async function ok(pathname, options) {
  const response = await call(pathname, options);
  assert.equal(response.code, 200, `${pathname} 应 200，得到 ${response.code} ${JSON.stringify(response.data)}`);
  return response.data;
}
async function fail(pathname, options) {
  const response = await call(pathname, options);
  assert.ok(response.code >= 400, `${pathname} 应失败，实际 ${response.code}`);
  return response;
}
const A = units => (BigInt(units) / UNITS).toString();

// ── 1. 游客可浏览 / 非商城路径不接管 ──
assert.equal(await mallApi.handle({ method: 'GET' }, {}, '/api/other'), false, '非 /api/mall/ 路径不接管');
const guestState = await ok('/api/mall/state', { method: 'GET', session: null });
assert.equal(guestState.wallet, '', '游客无个人数据');
assert.deepEqual(guestState.addresses, []);
assert.deepEqual(guestState.orders, []);
assert.equal(guestState.merchant, null);

// ── 2. 商户开店：未开店时商户接口被拒 → 申请生效 ──
await fail('/api/mall/merchant/products', { session: { address: MERCHANT } });
let state = await ok('/api/mall/merchant/state', { method: 'GET', session: { address: MERCHANT } });
assert.equal(state.merchant, null);
await fail('/api/mall/merchant/apply', { session: { address: MERCHANT }, body: { shopName: '' } });
await ok('/api/mall/merchant/apply', { session: { address: MERCHANT }, body: { shopName: '星辰杂货铺', intro: '好物严选' } });

// ── 3. 上架商品：字段校验 + 成功 ──
await fail('/api/mall/merchant/products', { session: { address: MERCHANT }, body: { title: '', priceA: '1', stock: 1 } });
await fail('/api/mall/merchant/products', { session: { address: MERCHANT }, body: { title: 'T', priceA: 'abc', stock: 1 } });
await fail('/api/mall/merchant/products', { session: { address: MERCHANT }, body: { title: 'T', priceA: '1', stock: 0 } });
const { product } = await ok('/api/mall/merchant/products', {
  session: { address: MERCHANT },
  body: { title: 'AIX 限定卫衣', description: '厚实印花', priceA: '12.5', stock: 5, imageUrl: '' },
});
assert.equal(product.status, 'active');
assert.equal(product.stock, 5);
assert.equal(A(product.priceUnits), '12');

// ── 4. 买家地址：首地址自动默认 / 校验 ──
await fail('/api/mall/addresses', { body: { receiver: '', phone: '13800138000', region: '广东省深圳市', detail: '科技园 1 号' } });
await fail('/api/mall/addresses', { body: { receiver: '小明', phone: 'abc', region: '广东省深圳市', detail: '科技园 1 号' } });
const { address } = await ok('/api/mall/addresses', {
  body: { receiver: '小明', phone: '13800138000', region: '广东省 深圳市 南山区', detail: '科技园 1 号 101' },
});
assert.equal(address.isDefault, true, '首个地址应自动设为默认');
let buyerState = await ok('/api/mall/state', { method: 'GET' });
assert.equal(buyerState.addresses.length, 1);
assert.equal(buyerState.products.length, 1, '商城应能刷到在售商品');
assert.equal(buyerState.products[0].shopName, '星辰杂货铺');

// ── 5. 下单：扣款 / 入账 / 扣库存 / 落单；不能买自己的商品 ──
const merchantBefore = ledger.get(MERCHANT.toLowerCase());
const buyerBefore = ledger.get(BUYER.toLowerCase());
await fail('/api/mall/orders', { session: { address: MERCHANT }, body: { productId: product.id, quantity: 1, addressId: address.id } });
const { order } = await ok('/api/mall/orders', { body: { productId: product.id, quantity: 2, addressId: address.id } });
assert.equal(order.status, 'paid');
assert.equal(order.quantity, 2);
assert.equal(A(order.totalUnits), '25', '12.5 × 2 = 25 AIX');
assert.equal(order.address.receiver, '小明');
assert.equal(ledger.get(BUYER.toLowerCase()), buyerBefore - 25n * UNITS, '买家应被扣 25 AIX');
assert.equal(ledger.get(MERCHANT.toLowerCase()), merchantBefore + 25n * UNITS, '商户应入账 25 AIX');
// 商城货款全额释放商户可卖额度：商家收到的 AIX 可直接在 AIX 交易大厅卖出
assert.equal(database.getATokenSellQuota(MERCHANT).releasedUnits, (25n * UNITS).toString(), '货款应全额释放可卖额度');
const stateAfterBuy = await ok('/api/mall/state', { method: 'GET' });
assert.equal(stateAfterBuy.products[0].stock, 3, '库存 5 → 3');
assert.equal(stateAfterBuy.products[0].sold, 2);
assert.equal(stateAfterBuy.orders.length, 1);

// ── 6. 取消：全额退款 + 回库存 ──
const { refundA } = await ok('/api/mall/orders/cancel', { body: { orderId: order.id } });
assert.equal(refundA, '25.0');
assert.equal(ledger.get(BUYER.toLowerCase()), buyerBefore, '取消后买家余额复原');
assert.equal(ledger.get(MERCHANT.toLowerCase()), merchantBefore, '取消后商户余额复原');
assert.equal(database.getATokenSellQuota(MERCHANT).releasedUnits, '0', '取消后可卖额度同步收回');
const stateAfterCancel = await ok('/api/mall/state', { method: 'GET' });
assert.equal(stateAfterCancel.products[0].stock, 5, '取消后库存回补到 5');
assert.equal(stateAfterCancel.orders[0].status, 'cancelled');
await fail('/api/mall/orders/cancel', { body: { orderId: order.id } }, '已取消订单不能重复取消');

// ── 7. 发货 → 确认收货 全流程 ──
const { order: order2 } = await ok('/api/mall/orders', { body: { productId: product.id, quantity: 1, addressId: address.id } });
await fail('/api/mall/merchant/orders/ship', { session: { address: BUYER }, body: { orderId: order2.id, company: '顺丰', tracking: 'SF123' } }, '买家不能发货');
const merchantState = await ok('/api/mall/merchant/state', { method: 'GET', session: { address: MERCHANT } });
assert.equal(merchantState.orders.length, 2);
assert.equal(merchantState.orders[0].status, 'paid');
const { order: shipped } = await ok('/api/mall/merchant/orders/ship', {
  session: { address: MERCHANT }, body: { orderId: order2.id, company: '顺丰速运', tracking: 'SF666888999' },
});
assert.equal(shipped.status, 'shipped');
assert.equal(shipped.shipCompany, '顺丰速运');
assert.equal(shipped.shipTracking, 'SF666888999');
await fail('/api/mall/orders/confirm', { body: { orderId: 'mo_not_exist' } });
const { order: completed } = await ok('/api/mall/orders/confirm', { body: { orderId: order2.id } });
assert.equal(completed.status, 'completed');
await fail('/api/mall/orders/cancel', { body: { orderId: order2.id } }, '已完成订单不能取消');
await fail('/api/mall/merchant/orders/ship', { session: { address: MERCHANT }, body: { orderId: order2.id, company: '顺丰', tracking: 'X' } }, '不能重复发货');

// ── 8. 余额不足 / 库存不足 ──
await ok('/api/mall/addresses', { body: { receiver: '小红', phone: '13900139000', region: '上海市', detail: '浦东新区 2 号' } });
ledger.set(BUYER.toLowerCase(), 3n * UNITS);  // 3 AIX < 12.5
await fail('/api/mall/orders', { body: { productId: product.id, quantity: 1, addressId: address.id } });
ledger.set(BUYER.toLowerCase(), 1000n * UNITS);
await fail('/api/mall/orders', { body: { productId: product.id, quantity: 99, addressId: address.id } }, '库存 4，99 件应失败');
// 用别人（非自己）的地址下单被拒
await fail('/api/mall/orders', { body: { productId: product.id, quantity: 1, addressId: 'mma_not_mine' } });

// ── 9. 改价 / 下架后不可购买 / 重新上架 ──
await fail('/api/mall/merchant/products/update', { session: { address: BUYER }, body: { id: product.id, priceA: '1' } }, '非本人不能编辑');
const { product: updated } = await ok('/api/mall/merchant/products/update', {
  session: { address: MERCHANT }, body: { id: product.id, priceA: '9.99', stock: 10 },
});
assert.equal(A(updated.priceUnits), '9');
assert.equal(updated.stock, 10);
await ok('/api/mall/merchant/products/update', { session: { address: MERCHANT }, body: { id: product.id, status: 'off' } });
await fail('/api/mall/orders', { body: { productId: product.id, quantity: 1, addressId: address.id } }, '下架后不可购买');
await ok('/api/mall/merchant/products/update', { session: { address: MERCHANT }, body: { id: product.id, status: 'active' } });
const { order: order3 } = await ok('/api/mall/orders', { body: { productId: product.id, quantity: 1, addressId: address.id } });
assert.equal(A(order3.totalUnits), '9', '改价后按新价 9.99 成交');

// ── 10. 地址管理：设默认 / 删除 / 上限 ──
const addresses = (await ok('/api/mall/addresses', { method: 'GET' })).addresses;
assert.equal(addresses.length, 2);
const second = addresses.find(a => !a.isDefault);
await ok('/api/mall/addresses/default', { body: { id: second.id } });
assert.equal((await ok('/api/mall/addresses', { method: 'GET' })).addresses.find(a => a.id === second.id).isDefault, true);
await ok('/api/mall/addresses/delete', { body: { id: second.id } });
assert.equal((await ok('/api/mall/addresses', { method: 'GET' })).addresses.length, 1);
for (let i = 0; i < 9; i++) {
  await ok('/api/mall/addresses', { body: { receiver: `备用${i}`, phone: '13800000000', region: '某省', detail: `某路 ${i} 号` } });
}
assert.equal((await ok('/api/mall/addresses', { method: 'GET' })).addresses.length, 10);
await fail('/api/mall/addresses', { body: { receiver: '超额', phone: '13800000000', region: '某省', detail: '某路' } }, '最多 10 个地址');

// ── 11. 封禁账户被拒 ──
wallets.delete(BUYER);
await fail('/api/mall/state', { method: 'GET' });
wallets.add(BUYER);

database.db?.close?.();
try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* 临时目录残留不影响结果 */ }
console.log('✓ AIX 商城 API 测试全部通过（开店/上架/下单/取消/发货/收货/边界）');
