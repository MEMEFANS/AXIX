import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { closeDatabase } from '../src/database.js';
import { createATokenService, A_TOKEN_DECIMALS } from '../src/a-token-service.js';
import { createATokenTeamService } from '../src/a-token-team-service.js';
import { createATokenOrderService, smallFirstAt } from '../src/a-token-order-service.js';
import { createReferralService } from '../src/referral-service.js';

// ══════════════════════════════════════════════════════════════
// P2P 撮合同价档排序规则：
//   价格仍是主键（卖低买高）；
//   同价档内 —— 默认轮：买单按金额大者优先（大额买家先成交），
//                      卖单按挂单时间先来先成交（大单小单都不因金额插队，都能优先卖给大额买家）；
//              小额轮：买、卖都按金额小者优先，让小卖单偶尔配给小买单。
//   每 matchSmallFirstWindow 次撮合尝试中有 matchSmallFirstCount 次小额轮。
// ══════════════════════════════════════════════════════════════

const A = v => BigInt(v) * 10n ** BigInt(A_TOKEN_DECIMALS);
const U6 = v => BigInt(v) * 10n ** 6n;
const pass = msg => console.log(`  ✓ ${msg}`);

// window=1 / count=0 → 永不进入小额轮（纯默认轮）；window=1 / count=1 → 每轮都是小额轮
function makeEnv(matchSmallFirstWindow, matchSmallFirstCount) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-match-priority-'));
  const walletService = createWalletService({ dataRoot: root, depositAddress: `0x${'D'.repeat(40)}`, networks: [] });
  const database = walletService.database;
  const at = createATokenService({ database, walletService });
  const teamService = createATokenTeamService({ database, walletService });
  const referralService = createReferralService({ database, walletService });
  const orderService = createATokenOrderService({
    aTokenService: at, database, teamService, referralService, matchSmallFirstWindow, matchSmallFirstCount,
  });
  at.setPrice('0.1'); // 1 AIX = 0.1 USDT
  const wallets = {};
  for (const key of ['a', 'b', 'c']) {
    wallets[key] = Wallet.createRandom().address.toLowerCase();
    walletService.ensureUser(wallets[key]);
  }
  return { root, walletService, database, at, orderService, wallets };
}

// 直接落库一笔 OPEN 委托（绕过 placeOrder 的冻结，只考察撮合排序）。
// 卖方手续费率固定 50%（构造时忽略；只影响成交数量，不影响成交顺序）。
function seed(env, { id, wallet, side, a = 0, usdt = 0, createdAt, priceUsdt = '0.1' }) {
  const price = env.at.parseUsdt(priceUsdt).toString();
  env.database.insertATokenOrderRow({
    id, wallet: wallet.toLowerCase(), side, orderType: 'limit',
    orderPriceUsdtUnits: price,
    inputUsdtUnits: side === 'buy' ? U6(usdt).toString() : '0',
    inputAUnits: side === 'sell' ? A(a).toString() : '0',
    status: 'OPEN', createdAt, updatedAt: createdAt,
    payload: { orderType: 'limit', feeRateBps: 5000, burnRateBps: 0, divRateBps: 0 },
  });
}

const statusOf = (env, id) => String(env.database.getATokenOrder(id)?.status || '');
const remainA = (env, id) => BigInt(env.database.getATokenOrder(id)?.input_a_units || '0');
const remainUsdt = (env, id) => BigInt(env.database.getATokenOrder(id)?.input_usdt_units || '0');

// ── 场景 1：默认轮 — 卖单按挂单时间先来先成交（大单小单都不因金额插队）──
// 小额卖单挂得更早、大额卖单挂得更晚。买单额度只够吃掉最前面的一笔。
// 时间优先 → 小额卖单先成交；若「卖单金额大者优先」→ 会先吃大额单，小额单原封不动。
{
  const env = makeEnv(1, 0); // 纯默认轮
  const { wallets } = env;
  seed(env, { id: 'sell_small', wallet: wallets.a, side: 'sell', a: 10, createdAt: 1000 });
  seed(env, { id: 'sell_big', wallet: wallets.b, side: 'sell', a: 1000, createdAt: 3000 });
  seed(env, { id: 'buy_1', wallet: wallets.c, side: 'buy', usdt: 10, createdAt: 500 });

  env.orderService.matchOpenOrders();

  assert.equal(statusOf(env, 'sell_small'), 'FILLED', '挂得更早的小额卖单应先成交（不被大额单插队）');
  assert.equal(statusOf(env, 'buy_1'), 'FILLED', '买单额度用尽');
  assert.equal(statusOf(env, 'sell_big'), 'OPEN', '大额卖单仍在挂单');
  pass('默认轮：卖单按挂单时间先来先成交（大单小单都优先卖给大额买家）');
  closeDatabase(env.root);
}

// ── 场景 2：默认轮 — 买单按金额大者优先（大额买家先成交，与挂单时间无关）──
// 小额买单挂得更早、大额买单挂得更晚。卖单额度只够吃掉一笔。
// 大额优先 → 大额买单成交，小额买单原封不动；若按时间优先 → 会先成交小额买单。
{
  const env = makeEnv(1, 0); // 纯默认轮
  const { wallets } = env;
  seed(env, { id: 'buy_small', wallet: wallets.a, side: 'buy', usdt: 2, createdAt: 400 });
  seed(env, { id: 'buy_big', wallet: wallets.b, side: 'buy', usdt: 3, createdAt: 500 });
  seed(env, { id: 'sell_1', wallet: wallets.c, side: 'sell', a: 30, createdAt: 2000 });

  env.orderService.matchOpenOrders();

  assert.equal(statusOf(env, 'sell_1'), 'FILLED', '卖单被吃满');
  assert.equal(statusOf(env, 'buy_big'), 'OPEN', '大额买单部分成交（仍在挂单）');
  assert.equal(remainUsdt(env, 'buy_small'), U6(2), '小额买单应原封不动（2 USDT）');
  pass('默认轮：同价档内买单金额大者优先');
  closeDatabase(env.root);
}

// ── 场景 3：小额轮 — 卖单金额小者优先 ──
// 每轮都是小额轮。大额卖单挂得更早、小额卖单挂得更晚。买单只够吃一笔。
// 小额轮 → 小额卖单被照顾；若按时间优先 → 会先吃大额卖单。
{
  const env = makeEnv(1, 1); // 每轮小额轮
  const { wallets } = env;
  seed(env, { id: 'sell_big', wallet: wallets.a, side: 'sell', a: 100, createdAt: 1000 });
  seed(env, { id: 'sell_small', wallet: wallets.b, side: 'sell', a: 10, createdAt: 2000 });
  seed(env, { id: 'buy_1', wallet: wallets.c, side: 'buy', usdt: 1, createdAt: 500 });

  env.orderService.matchOpenOrders();

  assert.equal(statusOf(env, 'sell_small'), 'FILLED', '小额卖单应被照顾成交');
  assert.equal(statusOf(env, 'buy_1'), 'FILLED', '买单额度用尽');
  assert.equal(statusOf(env, 'sell_big'), 'OPEN', '大额卖单仍在挂单');
  pass('小额轮：卖单按金额小者优先');
  closeDatabase(env.root);
}

// ── 场景 4：小额轮 — 小卖单配给小买单（而非大额买单）──
// 每轮都是小额轮。大额买单挂得更早、小额买单挂得更晚。
// 小额轮 → 买单金额小者优先 → 小额买单先成交，大额买单原封不动。
{
  const env = makeEnv(1, 1); // 每轮小额轮
  const { wallets } = env;
  seed(env, { id: 'buy_big', wallet: wallets.a, side: 'buy', usdt: 5, createdAt: 400 });
  seed(env, { id: 'buy_small', wallet: wallets.b, side: 'buy', usdt: 1, createdAt: 600 });
  seed(env, { id: 'sell_1', wallet: wallets.c, side: 'sell', a: 10, createdAt: 2000 });

  env.orderService.matchOpenOrders();

  assert.equal(statusOf(env, 'sell_1'), 'FILLED', '小卖单成交');
  assert.equal(remainUsdt(env, 'buy_big'), U6(5), '大额买单应原封不动（5 USDT）');
  assert.equal(remainUsdt(env, 'buy_small'), 500000n, '小额买单被吃掉一半（0.5 USDT）');
  pass('小额轮：小卖单配给小买单');
  closeDatabase(env.root);
}

// ── 场景 5：小额轮的分布（每 10 次尝试里 3 次，均匀铺开）──
{
  const of3 = Array.from({ length: 10 }, (_, i) => smallFirstAt(i + 1, 10, 3));
  assert.equal(of3.filter(Boolean).length, 3, '每 10 次尝试应有 3 次小额优先');
  assert.deepEqual(of3.map((f, i) => (f ? i + 1 : 0)).filter(Boolean), [4, 7, 10], '小额优先应均匀铺开');

  const of4 = Array.from({ length: 10 }, (_, i) => smallFirstAt(i + 1, 10, 4));
  assert.equal(of4.filter(Boolean).length, 4, 'count=4 时每 10 次尝试应有 4 次小额优先');
  assert.deepEqual(of4.map((f, i) => (f ? i + 1 : 0)).filter(Boolean), [3, 5, 8, 10], 'count=4 也应均匀铺开');

  assert.equal(smallFirstAt(5, 10, 0), false, 'count=0 表示关闭小额优先');
  pass('小额轮分布：每 10 次里 3 次（可调为 4 次），且均匀铺开');
}
