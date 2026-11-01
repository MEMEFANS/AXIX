// AIX 商城端到端测试脚本（仅本地）。
// 用法：
//   1) 停掉服务后执行  node scripts/mall-e2e.mjs seed   —— 往数据库写入两个带余额的测试钱包
//   2) 启动服务后执行  node scripts/mall-e2e.mjs test   —— 走完整 API 流程并输出结果
// 覆盖：登录、保证金开店（签名/审核）、商品多图/规格/简介、下单签名、担保冻结、
//       发货/取消/确认收货结算、评价、关店退保证金审核。
import { Wallet, formatUnits } from 'ethers';
import { openDatabase } from '../src/database.js';

const BASE = process.env.MALL_TEST_BASE || 'http://127.0.0.1:8080';
// 与 config.js 一致：WG_DATA_DIR 缺省 = app 根目录
const DATA_ROOT = process.env.WG_DATA_DIR || new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ESCROW = '0x000000000000000000000000000000000000e5c0';

// 固定测试私钥（仅本地测试，请勿用于真实资金）
const BUYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const MERCHANT_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e87258ed8fe33';
const buyer = new Wallet(BUYER_KEY);
const merchant = new Wallet(MERCHANT_KEY);

const A = n => BigInt(n) * 10n ** 18n;   // AIX 18 位
const U = n => BigInt(n) * 10n ** 6n;    // USDT 6 位

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}
async function api(path, { method = 'GET', body, cookie } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data, setCookie: r.headers.get('set-cookie') || '' };
}
async function login(wallet) {
  const c = await api('/api/wallet/login-challenge', { method: 'POST', body: { address: wallet.address } });
  if (c.status !== 200) throw new Error(`challenge 失败 ${JSON.stringify(c.data)}`);
  const signature = await wallet.signMessage(c.data.message);
  const s = await api('/api/wallet/login-sign', { method: 'POST', body: { address: wallet.address, message: c.data.message, signature } });
  if (s.status !== 200 || !s.data.token) throw new Error(`登录失败 ${JSON.stringify(s.data)}`);
  return `wg_session=${encodeURIComponent(s.data.token)}`;
}
const ts = () => String(Date.now());

async function seed() {
  const db = openDatabase(DATA_ROOT);
  const now = Date.now();
  const iso = new Date(now).toISOString();
  // 注意：服务实际从 payload_json 读取用户（loadWalletState），balances_json 仅作冗余索引
  const upsert = db.db.prepare(`INSERT INTO wallet_users(address,balances_json,created_at,updated_at,payload_json)
    VALUES(?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET balances_json=excluded.balances_json, updated_at=excluded.updated_at, payload_json=excluded.payload_json`);
  for (const w of [buyer, merchant]) {
    const balances = { USDT: U(1000).toString(), A: A(200000).toString(), BTC: '0', ETH: '0', BNB: '0' };
    const user = { address: w.address, balances, createdAt: iso, updatedAt: iso, level: 1 };
    upsert.run(w.address.toLowerCase(), JSON.stringify(balances), now, now, JSON.stringify(user));
  }
  console.log('已写入测试钱包（服务重启后生效）：');
  console.log('  买家    ', buyer.address, '1000 USDT / 200000 AIX');
  console.log('  商户    ', merchant.address, '1000 USDT / 200000 AIX');
}

async function test() {
  console.log(`\n== 商城端到端测试 ${BASE} ==\n[1] 公共接口`);
  const guest = await api('/api/mall/state');
  check('游客访问商城状态', guest.status === 200 && guest.data.depositInfo, `got ${guest.status}`);
  check('depositInfo 金额', guest.data.depositInfo?.usdt === '100' && guest.data.depositInfo?.aix === '5000');

  console.log('[2] 登录');
  const buyerCookie = await login(buyer);
  const merchantCookie = await login(merchant);
  check('买家登录', Boolean(buyerCookie));
  check('商户登录', Boolean(merchantCookie));

  console.log('[3] 开店保证金 + 入驻审核');
  // 无签名必须失败（若此前已提交过申请处于 pending，则走"仅更新资料"分支返回 200，同样不扣款）
  const noSign = await api('/api/mall/merchant/apply', { method: 'POST', cookie: merchantCookie, body: { shopName: '测试商铺', depositCurrency: 'USDT' } });
  check('无签名申请被拒', noSign.status === 401 || noSign.data?.pending === true, `got ${noSign.status}`);
  // 正确签名（签名消息与提交的时间戳必须一致）
  const tApply = ts();
  const sign = await merchant.signMessage(`AxiX 商城开店保证金：缴纳 100 USDT，店铺「测试商铺」，时间：${tApply}`);
  const applied = await api('/api/mall/merchant/apply', { method: 'POST', cookie: merchantCookie,
    body: { shopName: '测试商铺', intro: '端到端测试店铺', depositCurrency: 'USDT', timestamp: tApply, signature: sign } });
  check('签名+缴保证金申请成功', applied.status === 200 && applied.data.merchant?.status === 'pending', JSON.stringify(applied.data).slice(0, 120));
  // 审核中不能上架
  const blocked = await api('/api/mall/merchant/products', { method: 'POST', cookie: merchantCookie, body: { title: 'x', priceA: '1', stock: 1 } });
  check('审核中上架被拦截', blocked.status === 403, `got ${blocked.status}`);
  // 重复申请不重复扣款
  const dup = await api('/api/mall/merchant/apply', { method: 'POST', cookie: merchantCookie, body: { shopName: '测试商铺' } });
  check('审核中重复申请不扣款', dup.status === 200 && dup.data.pending === true);

  console.log('[4] 平台后台审核');
  const adminLogin = await api('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'WG-Admin-2026' } });
  const adminCookie = adminLogin.setCookie.match(/wg_admin_session=[^;]+/)?.[0] || null;
  check('管理员登录', Boolean(adminCookie), `got ${adminLogin.status}`);
  const pendingList = await api('/api/admin/mall/merchants?status=pending', { cookie: adminCookie });
  check('后台看到待审核商户', pendingList.status === 200 && pendingList.data.merchants?.some(m => m.wallet.toLowerCase() === merchant.address.toLowerCase()));
  const approve = await api('/api/admin/mall/merchants/approve', { method: 'POST', cookie: adminCookie, body: { wallet: merchant.address } });
  check('审核通过', approve.status === 200 && approve.data.merchant?.status === 'active');

  console.log('[5] 商品上架（多图/规格/简介）');
  const imgs = Array.from({ length: 6 }, (_, i) => `https://example.com/p${i + 1}.jpg`);
  const created = await api('/api/mall/merchant/products', { method: 'POST', cookie: merchantCookie,
    body: { title: 'AIX 测试商品', priceA: '10', stock: 20, summary: '一句话简介', spec: '尺码 L', images: imgs, description: '详细描述' } });
  const product = created.data.product;
  check('创建商品', created.status === 200 && product?.id, JSON.stringify(created.data).slice(0, 120));
  check('商品带多图/规格/简介', product?.images?.length === 6 && product?.spec === '尺码 L' && product?.summary === '一句话简介');
  const tooMany = await api('/api/mall/merchant/products', { method: 'POST', cookie: merchantCookie, body: { title: 'x', priceA: '1', stock: 1, images: [...imgs, 'https://example.com/p7.jpg'] } });
  check('超过 6 张图被拒', tooMany.status === 400);
  const state1 = await api('/api/mall/state', { cookie: buyerCookie });
  check('商城列表可见商品', state1.data.products?.some(p => p.id === product.id));

  console.log('[6] 收货地址 + 下单签名 + 担保冻结');
  const addr = await api('/api/mall/addresses', { method: 'POST', cookie: buyerCookie,
    body: { receiver: '张三', phone: '13800001111', region: '上海 上海市 浦东新区', detail: '测试路 1 号', isDefault: true } });
  const addressId = addr.data.address?.id;
  check('创建收货地址', addr.status === 200 && Boolean(addressId), JSON.stringify(addr.data).slice(0, 120));
  const buyNoSign = await api('/api/mall/orders', { method: 'POST', cookie: buyerCookie, body: { productId: product.id, quantity: 2, addressId } });
  check('无签名下单被拒', buyNoSign.status === 401, `got ${buyNoSign.status}`);
  const t1 = ts();
  const buySign = await buyer.signMessage(`AxiX 商城下单确认：商品 ${product.id}，数量 2 件，时间：${t1}`);
  const bought = await api('/api/mall/orders', { method: 'POST', cookie: buyerCookie,
    body: { productId: product.id, quantity: 2, addressId, timestamp: t1, signature: buySign } });
  const order = bought.data.order;
  check('签名下单成功', bought.status === 200 && order?.status === 'paid', JSON.stringify(bought.data).slice(0, 150));
  check('买家扣款后余额', Number(bought.data.balanceA) === 199980, `got ${bought.data.balanceA}`); // 200000 - 2*10
  // 商户侧余额（/api/mall/merchant/state.balanceA）验证货款未即时到账（仍在担保账户冻结）
  const mstateA1 = await api('/api/mall/merchant/state', { cookie: merchantCookie });
  check('商户未即时到账', Number(mstateA1.data.balanceA) === 200000, `merchant=${mstateA1.data.balanceA}`);

  console.log('[7] 取消退款（第二单）');
  const t2 = ts();
  const buySign2 = await buyer.signMessage(`AxiX 商城下单确认：商品 ${product.id}，数量 1 件，时间：${t2}`);
  const bought2 = await api('/api/mall/orders', { method: 'POST', cookie: buyerCookie,
    body: { productId: product.id, quantity: 1, addressId, timestamp: t2, signature: buySign2 } });
  const cancel = await api('/api/mall/orders/cancel', { method: 'POST', cookie: buyerCookie, body: { orderId: bought2.data.order.id } });
  check('待发货订单取消退款', cancel.status === 200 && cancel.data.order?.status === 'cancelled');
  check('退款后买家余额', Number(cancel.data.balanceA) === 199980, `got ${cancel.data.balanceA}`);

  console.log('[8] 发货 → 确认收货 → 结算');
  const ship = await api('/api/mall/merchant/orders/ship', { method: 'POST', cookie: merchantCookie,
    body: { orderId: order.id, company: '顺丰', tracking: 'SF1234567890' } });
  check('商户发货', ship.status === 200 && ship.data.order?.status === 'shipped');
  const cancelLate = await api('/api/mall/orders/cancel', { method: 'POST', cookie: buyerCookie, body: { orderId: order.id } });
  check('已发货不能取消', cancelLate.status === 400);
  const confirm = await api('/api/mall/orders/confirm', { method: 'POST', cookie: buyerCookie, body: { orderId: order.id } });
  check('确认收货', confirm.status === 200 && confirm.data.order?.status === 'completed');
  const mstateA2 = await api('/api/mall/merchant/state', { cookie: merchantCookie });
  check('确认收货后货款结算给商户', Number(mstateA2.data.balanceA) === 200020, `merchant=${mstateA2.data.balanceA}`);

  console.log('[9] 买家评价');
  const review = await api('/api/mall/orders/review', { method: 'POST', cookie: buyerCookie, body: { orderId: order.id, rating: 5, content: '担保交易很放心' } });
  check('发表评价', review.status === 200);
  const dupReview = await api('/api/mall/orders/review', { method: 'POST', cookie: buyerCookie, body: { orderId: order.id, rating: 4, content: '重复' } });
  check('重复评价被拒', dupReview.status === 400);
  const reviews = await api(`/api/mall/reviews?productId=${product.id}`);
  check('商品评价公开可见', reviews.status === 200 && reviews.data.reviews?.length === 1 && reviews.data.reviews[0].rating === 5);
  const state2 = await api('/api/mall/state');
  const p2 = state2.data.products?.find(p => p.id === product.id);
  check('商品卡片带评分', p2?.reviewCount === 1 && Number(p2?.ratingAvg) === 5, `count=${p2?.reviewCount} avg=${p2?.ratingAvg}`);

  console.log('[10] 超时自动确认收货');
  const t3 = ts();
  const buySign3 = await buyer.signMessage(`AxiX 商城下单确认：商品 ${product.id}，数量 1 件，时间：${t3}`);
  const bought3 = await api('/api/mall/orders', { method: 'POST', cookie: buyerCookie,
    body: { productId: product.id, quantity: 1, addressId, timestamp: t3, signature: buySign3 } });
  const order3 = bought3.data.order;
  check('第三单下单成功', bought3.status === 200 && order3?.status === 'paid');
  const ship3 = await api('/api/mall/merchant/orders/ship', { method: 'POST', cookie: merchantCookie,
    body: { orderId: order3.id, company: '中通', tracking: 'ZT99887766' } });
  check('第三单发货', ship3.status === 200 && ship3.data.order?.status === 'shipped');
  // 把发货时间改到 16 天前（模拟超时未确认），触发后台自动确认任务
  const db = openDatabase(DATA_ROOT);
  db.db.prepare(`UPDATE mall_orders SET shipped_at=? WHERE id=?`).run(Date.now() - 16 * 86400000, order3.id);
  const autoRun = await api('/api/admin/mall/orders/auto-confirm-run', { method: 'POST', cookie: adminCookie, body: {} });
  check('自动确认任务执行', autoRun.status === 200 && autoRun.data.completed >= 1, JSON.stringify(autoRun.data));
  const mstateA3 = await api('/api/mall/merchant/state', { cookie: merchantCookie });
  check('超时订单货款自动结算给商户', Number(mstateA3.data.balanceA) === 200030, `merchant=${mstateA3.data.balanceA}`);
  const buyerOrders = await api('/api/mall/state', { cookie: buyerCookie });
  check('超时订单状态已完结', buyerOrders.data.orders?.find(o => o.id === order3.id)?.status === 'completed');
  // 重复触发不会重复结算
  const autoRun2 = await api('/api/admin/mall/orders/auto-confirm-run', { method: 'POST', cookie: adminCookie, body: {} });
  const mstateA4 = await api('/api/mall/merchant/state', { cookie: merchantCookie });
  check('重复触发不重复结算', Number(mstateA4.data.balanceA) === 200030, `merchant=${mstateA4.data.balanceA}`);
  const ordersAdmin = await api('/api/admin/mall/orders', { cookie: adminCookie });
  check('后台订单总览可见', ordersAdmin.status === 200 && ordersAdmin.data.orders?.some(o => o.id === order3.id), `got ${ordersAdmin.status}`);
  check('担保在冻资金归零', Number(ordersAdmin.data.escrowFrozenA) === 0, `frozen=${ordersAdmin.data.escrowFrozenA}`);

  console.log('[11] 关店退保证金');
  const closeEarly = await api('/api/mall/merchant/close-apply', { method: 'POST', cookie: merchantCookie, body: {} });
  check('有在售商品时关店被拒', closeEarly.status === 400, `got ${closeEarly.status}`);
  await api('/api/mall/merchant/products/update', { method: 'POST', cookie: merchantCookie, body: { id: product.id, status: 'off' } });
  const closeApply = await api('/api/mall/merchant/close-apply', { method: 'POST', cookie: merchantCookie, body: {} });
  check('下架后关店申请成功', closeApply.status === 200 && closeApply.data.merchant?.status === 'closing');
  const sellBlocked = await api('/api/mall/merchant/products/update', { method: 'POST', cookie: merchantCookie, body: { id: product.id, status: 'active' } });
  check('关店审核中不能上架', sellBlocked.status === 403, `got ${sellBlocked.status}`);
  const closeApprove = await api('/api/admin/mall/merchants/close-approve', { method: 'POST', cookie: adminCookie, body: { wallet: merchant.address } });
  check('后台同意关店', closeApprove.status === 200 && closeApprove.data.merchant?.status === 'closed');
  check('保证金已退回商户', closeApprove.data.merchant?.deposit?.refundedAt > 0);
  const mstate = await api('/api/mall/merchant/state', { cookie: merchantCookie });
  check('商户端看到已关店', mstate.data.merchant?.status === 'closed');

  console.log(`\n== 结果：${passed} 通过 / ${failed} 失败 ==`);
  process.exit(failed ? 1 : 0);
}

const mode = process.argv[2];
if (mode === 'seed') await seed();
else if (mode === 'test') await test();
else { console.log('用法: node scripts/mall-e2e.mjs [seed|test]'); process.exit(1); }
