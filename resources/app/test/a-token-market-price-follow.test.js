import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { createATokenService, A_TOKEN_DECIMALS } from '../src/a-token-service.js';
import { createATokenTeamService } from '../src/a-token-team-service.js';
import { createATokenOrderService } from '../src/a-token-order-service.js';
import { createReferralService } from '../src/referral-service.js';

// ══════════════════════════════════════════════════════════════
// 市价单「委托价跟随现价」：
//   - 挂单中（OPEN）的市价单，读取时直接按当前币价展示（不依赖撮合轮刷新，
//     manual 模式下 K 线 tick 不跑，撮合轮也不会执行）
//   - 限价单保持用户指定价
//   - 已结束（FILLED/CANCELLED）的市价单保留成交时的历史价
// ══════════════════════════════════════════════════════════════

const A = v => BigInt(v) * 10n ** BigInt(A_TOKEN_DECIMALS);
const U6 = v => BigInt(v) * 10n ** 6n;
const pass = msg => console.log(`  ✓ ${msg}`);

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-market-price-'));
  const walletService = createWalletService({ dataRoot: root, depositAddress: `0x${'D'.repeat(40)}`, networks: [] });
  const database = walletService.database;
  const at = createATokenService({ database, walletService });
  const teamService = createATokenTeamService({ database, walletService });
  const referralService = createReferralService({ database, walletService });
  const orderService = createATokenOrderService({ aTokenService: at, database, teamService, referralService });
  at.setPrice('0.1');
  const wallets = {};
  for (const key of ['buyer', 'seller']) {
    wallets[key] = Wallet.createRandom().address.toLowerCase();
    walletService.ensureUser(wallets[key]);
  }
  at.creditUsdt(wallets.buyer, U6(1000));
  at.creditA(wallets.seller, A(1000));
  return { root, walletService, database, at, orderService, wallets };
}

const myOrder = (env, wallet, orderId) =>
  env.orderService.myOrders({ wallet }).find(o => o.orderId === orderId);
// formatUnits 会去掉小数末尾的 0（'0.1' 而非 '0.100000'），统一按 4 位小数比较
const p4 = v => Number(v).toFixed(4);

// ── 场景 1：撮合轮没跑，OPEN 市价单也要跟随现价 ──
{
  const env = makeEnv();
  const r = env.orderService.placeOrder({ wallet: env.wallets.buyer, side: 'buy', orderType: 'market', amount: '100' });
  assert.equal(r.orderStatus, 'OPEN', '无对手方时应挂单');
  assert.equal(p4(myOrder(env, env.wallets.buyer, r.orderId).orderPriceUsdt), '0.1000');
  env.at.setPrice('0.2');
  // 注意：这里刻意不调用 matchOpenOrders()
  assert.equal(p4(myOrder(env, env.wallets.buyer, r.orderId).orderPriceUsdt), '0.2000', '改价后应立刻跟随，无需撮合轮');
  assert.equal(p4(env.orderService.openOrders({}).buys[0].priceUsdt), '0.2000', '挂单明细里市价单价格同样跟随');
  pass('OPEN 市价单不依赖撮合轮，读取即跟随现价（我的委托 + 挂单明细）');
}

// ── 场景 2：限价单保持用户指定价 ──
{
  const env = makeEnv();
  const r = env.orderService.placeOrder({ wallet: env.wallets.buyer, side: 'buy', orderType: 'limit', priceUsdt: '0.05', amount: '100' });
  assert.equal(p4(myOrder(env, env.wallets.buyer, r.orderId).orderPriceUsdt), '0.0500');
  env.at.setPrice('0.2');
  assert.equal(p4(myOrder(env, env.wallets.buyer, r.orderId).orderPriceUsdt), '0.0500', '限价单不得被现价覆盖');
  assert.equal(p4(env.orderService.openOrders({}).buys[0].priceUsdt), '0.0500');
  pass('限价单保持用户指定价不受现价影响');
}

// ── 场景 3：已成交（FILLED）的市价单保留历史价 ──
{
  const env = makeEnv();
  const sell = env.orderService.placeOrder({ wallet: env.wallets.seller, side: 'sell', orderType: 'limit', priceUsdt: '0.1', amount: '10' });
  assert.equal(sell.orderStatus, 'OPEN');
  // 市价买单 0.5 USDT → 按 0.1 价需要 5 AIX（小于卖家可成交净额，应全额成交）
  const buy = env.orderService.placeOrder({ wallet: env.wallets.buyer, side: 'buy', orderType: 'market', amount: '0.5' });
  assert.equal(buy.orderStatus, 'FILLED', '应吃到对手方限价卖单');
  assert.equal(p4(myOrder(env, env.wallets.buyer, buy.orderId).orderPriceUsdt), '0.1000');
  env.at.setPrice('0.5');
  assert.equal(p4(myOrder(env, env.wallets.buyer, buy.orderId).orderPriceUsdt), '0.1000', '已结束订单保留历史价');
  pass('FILLED 市价单保留成交时的历史价');
}

// ── 场景 4：挂单（maker）被部分吃掉后，剩余委托量必须按成交量递减 ──
{
  const env = makeEnv();
  // 卖家挂限价卖单 10 AIX @ 0.1；直推 0 人 → 费率 50% → 可成交净额 5 AIX
  const sell = env.orderService.placeOrder({ wallet: env.wallets.seller, side: 'sell', orderType: 'limit', priceUsdt: '0.1', amount: '10' });
  assert.equal(sell.orderStatus, 'OPEN');
  assert.equal(Number(myOrder(env, env.wallets.seller, sell.orderId).inputA), 10, '初始挂单量应为 10 AIX');

  // 买家限价买入 0.2 USDT @ 0.1 → 吃 2 AIX（净额口径消耗 4 AIX 含费），卖家剩余应为 6 AIX
  const buy = env.orderService.placeOrder({ wallet: env.wallets.buyer, side: 'buy', orderType: 'limit', priceUsdt: '0.1', amount: '0.2' });
  assert.equal(buy.orderStatus, 'FILLED', '小额买单应全额成交');
  const sellAfter = myOrder(env, env.wallets.seller, sell.orderId);
  assert.equal(sellAfter.orderStatus, 'OPEN', '卖家仅被部分成交，应仍为挂单中');
  assert.equal(Number(sellAfter.inputA), 6, '卖家挂单量应从 10 递减到 6 AIX');
  assert.equal(Number(sellAfter.filledA), 2, '卖家累计成交量应为 2 AIX');
  pass('限价卖单（maker）部分成交后，挂单量按成交量递减且状态保持挂单中');
}

// ── 场景 5：限价买单（maker）被吃掉后，剩余 USDT 委托量递减 ──
{
  const env = makeEnv();
  // 买家挂限价买单 10 USDT @ 0.1（买方 0 手续费，全额冻结）
  const buy = env.orderService.placeOrder({ wallet: env.wallets.buyer, side: 'buy', orderType: 'limit', priceUsdt: '0.1', amount: '10' });
  assert.equal(buy.orderStatus, 'OPEN');
  assert.equal(Number(myOrder(env, env.wallets.buyer, buy.orderId).inputUsdt), 10, '初始冻结应为 10 USDT');

  // 卖家限价卖出 10 AIX @ 0.1（净额 5 AIX）→ 吃掉买家 5 AIX = 0.5 USDT，买家剩余 9.5 USDT
  const sell = env.orderService.placeOrder({ wallet: env.wallets.seller, side: 'sell', orderType: 'limit', priceUsdt: '0.1', amount: '10' });
  assert.equal(sell.orderStatus, 'FILLED', '卖家净额被买家完全吸收');
  const buyAfter = myOrder(env, env.wallets.buyer, buy.orderId);
  assert.equal(buyAfter.orderStatus, 'OPEN', '买家仅部分成交，应仍挂单中');
  assert.equal(Number(buyAfter.inputUsdt), 9.5, '买家挂单金额应从 10 递减到 9.5 USDT');
  assert.equal(Number(buyAfter.filledUsdt), 0.5, '买家累计成交额应为 0.5 USDT');
  assert.equal(Number(buyAfter.filledA), 5, '买家累计买入应为 5 AIX');
  pass('限价买单（maker）部分成交后，冻结 USDT 委托量递减且状态保持挂单中');
}

// ── 场景 6：maker 被全额吃掉后应变 FILLED 且剩余量归零 ──
{
  const env = makeEnv();
  const sell = env.orderService.placeOrder({ wallet: env.wallets.seller, side: 'sell', orderType: 'limit', priceUsdt: '0.1', amount: '10' });
  const buy = env.orderService.placeOrder({ wallet: env.wallets.buyer, side: 'buy', orderType: 'limit', priceUsdt: '0.1', amount: '0.5' });
  assert.equal(buy.orderStatus, 'FILLED', '买单应全额成交');
  const sellAfter = myOrder(env, env.wallets.seller, sell.orderId);
  assert.equal(sellAfter.orderStatus, 'FILLED', '卖单净额被吃光后应变已成交');
  assert.equal(Number(sellAfter.inputA), 0, '已成交的挂单剩余量应归零');
  assert.equal(Number(sellAfter.filledA), 5, '已成交的挂单成交量应为 5 AIX（净额）');
  pass('maker 被全额吃掉后状态变为已成交、剩余量归零、成交量正确');
}
