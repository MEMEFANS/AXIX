// AIX 匹配池端到端测试脚本（仅本地）。
// 用法：
//   1) 停掉服务后执行  node scripts/match-pool-e2e.mjs seed   —— 写入带余额 + 匹配额度的测试钱包
//   2) 启动服务后执行  node scripts/match-pool-e2e.mjs test   —— 走完整 API 流程并输出结果
// 覆盖：总览、涡轮报价、购买涡轮（签名/幂等重放）、1:1 进池、锁定时长递增规则、
//       到期懒释放为可用额度、卖出只消耗可用额度（匹配额度不能直接卖）。
import { Wallet } from 'ethers';
import { openDatabase } from '../src/database.js';

const BASE = process.env.MATCH_POOL_TEST_BASE || 'http://127.0.0.1:8080';
// 与 config.js 一致：WG_DATA_DIR 缺省 = app 根目录
const DATA_ROOT = process.env.WG_DATA_DIR || new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// 固定测试私钥（仅本地测试，请勿用于真实资金）——与 mall-e2e 买家同一钱包
const TESTER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const tester = new Wallet(TESTER_KEY);

const A = n => BigInt(n) * 10n ** 18n;   // AIX 18 位
const U = n => BigInt(n) * 10n ** 6n;    // USDT 6 位

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}
async function api(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
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
  // 服务实际从 payload_json 读取用户（loadWalletState），balances_json 仅作冗余索引
  const upsert = db.db.prepare(`INSERT INTO wallet_users(address,balances_json,created_at,updated_at,payload_json)
    VALUES(?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET balances_json=excluded.balances_json, updated_at=excluded.updated_at, payload_json=excluded.payload_json`);
  const balances = { USDT: U(2000).toString(), A: A(200000).toString(), BTC: '0', ETH: '0', BNB: '0' };
  const user = { address: tester.address, balances, createdAt: iso, updatedAt: iso, level: 1 };
  upsert.run(tester.address.toLowerCase(), JSON.stringify(balances), now, now, JSON.stringify(user));
  // 匹配额度（原可卖额度账本）：质押产出语义，直接种 2000 AIX released
  db.db.prepare(`INSERT INTO a_token_sell_quotas(wallet,released_units,used_units,updated_at)
    VALUES(?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET released_units=excluded.released_units, used_units='0', updated_at=excluded.updated_at`)
    .run(tester.address.toLowerCase(), A(2000).toString(), '0', now);
  // 清掉历史匹配池状态/条目/涡轮，保证测试可重复
  for (const t of ['a_token_match_pool_state', 'a_token_match_pool_entries', 'a_token_turbo_quotas', 'a_token_turbo_purchases', 'a_token_usable_quotas']) {
    db.db.prepare(`DELETE FROM ${t} WHERE wallet=?`).run(tester.address.toLowerCase());
  }
  console.log('已写入测试钱包（服务重启后生效）：');
  console.log('  测试者  ', tester.address, '2000 USDT / 200000 AIX / 2000 AIX 匹配额度');
}

async function test() {
  console.log(`\n== 匹配池端到端测试 ${BASE} ==\n[1] 登录`);
  const cookie = await login(tester);
  check('测试钱包登录', Boolean(cookie));
  const addr = tester.address.toLowerCase();

  console.log('[2] 匹配池总览（初始）');
  const ov0 = await api('/api/a-token/match-pool', { cookie });
  check('总览接口可用', ov0.status === 200, `got ${ov0.status}`);
  check('匹配额度 = 2000（种子）', Number(ov0.data.matchQuota?.available) === 2000, `got ${ov0.data.matchQuota?.available}`);
  check('涡轮额度 = 0', Number(ov0.data.turboQuota) === 0);
  check('可用额度 = 0', Number(ov0.data.usableQuota?.available) === 0);
  check('未开始计时（nextDuration=24h）', ov0.data.started === false && Number(ov0.data.nextDurationHours) === 24, JSON.stringify({ started: ov0.data.started, h: ov0.data.nextDurationHours }));

  console.log('[3] 涡轮报价（按 AIX 数量 → 应付 USDT）');
  const quote = await api('/api/a-token/match-pool/quote?aix=2000', { cookie });
  check('报价接口可用', quote.status === 200 && Number(quote.data.usdtOut) > 0, JSON.stringify(quote.data).slice(0, 120));
  check('报价 AIX 数量回显', quote.data.aixIn === '2000.0' || quote.data.aixIn === '2000', `got ${quote.data.aixIn}`);
  check('报价含实时价', Number(quote.data.priceUsdt) > 0, `price=${quote.data.priceUsdt}`);
  const usdtCost = Number(quote.data.usdtOut);
  check('USDT 成本在种子余额内', usdtCost > 0 && usdtCost < 2000, `cost=${usdtCost}（价格异常时请检查 K 线价格）`);
  const tooSmall = await api('/api/a-token/match-pool/quote?aix=1', { cookie });
  check('低于 1 USDT 等值报价被拒', tooSmall.status === 400, `got ${tooSmall.status}`);

  console.log('[4] 购买涡轮额度（签名 + 幂等）');
  const noSign = await api('/api/a-token/match-pool/buy-turbo', { method: 'POST', cookie, body: { aix: '2000' } });
  check('无签名购买被拒', noSign.status === 401 || noSign.status === 400, `got ${noSign.status}`);
  const prof0 = await api('/api/a-token/profile', { cookie });
  const usdtBefore = Number(prof0.data.balances?.USDT);
  const reqId = 'tbo_test_' + Date.now();
  const t1 = ts();
  const sign1 = await tester.signMessage(`AxiX 涡轮额度购买确认：支付 ${quote.data.usdtOut} USDT，编号 ${reqId}，时间：${t1}`);
  const bought = await api('/api/a-token/match-pool/buy-turbo', { method: 'POST', cookie,
    headers: { 'Idempotency-Key': reqId },
    body: { aix: '2000', timestamp: t1, signature: sign1 } });
  check('签名购买成功', bought.status === 200 && Number(bought.data.turboOut) === 2000, JSON.stringify(bought.data).slice(0, 150));
  check('到账 AIX 数量精确 = 2000', bought.data.turboOut === '2000.0' || bought.data.turboOut === '2000', `got ${bought.data.turboOut}`);
  check('扣款 USDT 与报价一致', bought.data.usdtIn === quote.data.usdtOut, `${bought.data.usdtIn} vs ${quote.data.usdtOut}`);
  check('涡轮余额累计 2000', Number(bought.data.turboBalance) === 2000, `got ${bought.data.turboBalance}`);
  // 幂等重放：同编号同签名 → 不重复扣款
  const replay = await api('/api/a-token/match-pool/buy-turbo', { method: 'POST', cookie,
    headers: { 'Idempotency-Key': reqId },
    body: { aix: '2000', timestamp: t1, signature: sign1 } });
  check('幂等重放不重复扣款', replay.status === 200 && replay.data.idempotent === true && Number(replay.data.turboBalance) === 2000, JSON.stringify(replay.data).slice(0, 150));
  // USDT 恰好扣报价金额（相对值断言：服务端余额为内存态，seed 重跑不影响）
  const prof1 = await api('/api/a-token/profile', { cookie });
  check('USDT 恰好扣报价金额', Math.abs(usdtBefore - Number(prof1.data.balances?.USDT) - usdtCost) < 1e-6, `${usdtBefore} → ${prof1.data.balances?.USDT}（报价 ${usdtCost}）`);
  const ov1 = await api('/api/a-token/match-pool', { cookie });
  check('购买记录入列', (ov1.data.purchases || []).some(p => p.id === bought.data.purchaseId));

  console.log('[5] 放入匹配池（1:1 配比）');
  const overMatch = await api('/api/a-token/match-pool/enter', { method: 'POST', cookie, body: { amount: '2500' } });
  check('匹配额度不足被拦截', overMatch.status === 400 && String(overMatch.data.error || '').includes('匹配额度不足'), `got ${overMatch.status} ${overMatch.data.error || ''}`);
  // 1:1 消耗下两额度差恒定，正常流程撞不到涡轮不足分支 → 临时把涡轮改小验证该校验
  const dbFix = openDatabase(DATA_ROOT);
  const turboRow = dbFix.db.prepare(`SELECT units FROM a_token_turbo_quotas WHERE wallet=?`).get(addr);
  dbFix.db.prepare(`UPDATE a_token_turbo_quotas SET units=? WHERE wallet=?`).run(A(100).toString(), addr);
  const overTurbo = await api('/api/a-token/match-pool/enter', { method: 'POST', cookie, body: { amount: '150' } });
  check('涡轮不足被拦截', overTurbo.status === 400 && String(overTurbo.data.error || '').includes('涡轮额度不足'), `got ${overTurbo.status} ${overTurbo.data.error || ''}`);
  dbFix.db.prepare(`UPDATE a_token_turbo_quotas SET units=? WHERE wallet=?`).run(turboRow.units, addr);
  const enter = await api('/api/a-token/match-pool/enter', { method: 'POST', cookie, body: { amount: '150' } });
  check('放入成功', enter.status === 200 && enter.data.entry?.status === 'locked', JSON.stringify(enter.data).slice(0, 150));
  check('首次使用锁定 24 小时', Number(enter.data.entry?.durationHours) === 24, `got ${enter.data.entry?.durationHours}`);
  check('到期产出 2× = 300', Number(enter.data.entry?.totalA) === 300, `got ${enter.data.entry?.totalA}`);
  const ov2 = await api('/api/a-token/match-pool', { cookie });
  check('匹配额度扣 150', Number(ov2.data.matchQuota?.available) === 1850, `got ${ov2.data.matchQuota?.available}`);
  check('涡轮额度扣 150', Number(ov2.data.turboQuota) === 1850, `got ${ov2.data.turboQuota}`);
  check('已开始计时（第 1 天）', ov2.data.started === true && Number(ov2.data.dayIndex) === 1);
  check('条目入列且为锁定态', ov2.data.entries?.[0]?.status === 'locked' && Number(ov2.data.entries?.[0]?.remainMs) > 0);

  console.log('[6] 卖出校验：可用额度不足（匹配额度不能直接卖）');
  const sellBlocked = await api('/api/a-token/orders', { method: 'POST', cookie, body: { side: 'sell', orderType: 'market', amount: '100' } });
  check('无可用额度卖出被拒', sellBlocked.status === 400 && String(sellBlocked.data.error || '').includes('可用额度不足'), `got ${sellBlocked.status} ${sellBlocked.data.error || ''}`);

  console.log('[7] 到期释放 → 可用额度 → 可卖出');
  const db = openDatabase(DATA_ROOT);
  db.db.prepare(`UPDATE a_token_match_pool_entries SET matures_at=? WHERE wallet=? AND status='locked'`).run(Date.now() - 1000, addr);
  const ov3 = await api('/api/a-token/match-pool', { cookie });   // 懒释放本人到期条目
  check('到期条目已释放', ov3.data.entries?.[0]?.status === 'released', `got ${ov3.data.entries?.[0]?.status}`);
  check('可用额度到账 300', Number(ov3.data.usableQuota?.available) === 300, `got ${ov3.data.usableQuota?.available}`);
  const sell = await api('/api/a-token/orders', { method: 'POST', cookie, body: { side: 'sell', orderType: 'market', amount: '100' } });
  check('有可用额度可卖出', sell.status === 200 && sell.data.ok === true, JSON.stringify(sell.data).slice(0, 150));
  const ov4 = await api('/api/a-token/match-pool', { cookie });
  check('卖出占用可用额度 100', Number(ov4.data.usableQuota?.available) === 200, `got ${ov4.data.usableQuota?.available}`);
  // 撤单返还可用额度（挂单未成交时）
  if (sell.data.orderStatus === 'OPEN' && sell.data.orderId) {
    const cancel = await api(`/api/a-token/orders/${sell.data.orderId}`, { method: 'DELETE', cookie });
    check('撤单成功', cancel.status === 200, `got ${cancel.status}`);
    const ov5 = await api('/api/a-token/match-pool', { cookie });
    check('撤单返还可用额度', Number(ov5.data.usableQuota?.available) === 300, `got ${ov5.data.usableQuota?.available}`);
  }

  console.log('[8] 锁定时长递增规则（每日 +24h，封顶 720h）');
  const now = Date.now();
  db.db.prepare(`UPDATE a_token_match_pool_state SET first_pool_at=? WHERE wallet=?`).run(now - 2 * 86400000, addr);
  const ovD3 = await api('/api/a-token/match-pool', { cookie });
  check('第 3 天 → 72h', Number(ovD3.data.nextDurationHours) === 72 && Number(ovD3.data.dayIndex) === 3, `got ${ovD3.data.nextDurationHours}h day=${ovD3.data.dayIndex}`);
  db.db.prepare(`UPDATE a_token_match_pool_state SET first_pool_at=? WHERE wallet=?`).run(now - 40 * 86400000, addr);
  const ovD40 = await api('/api/a-token/match-pool', { cookie });
  check('第 41 天 → 封顶 720h', Number(ovD40.data.nextDurationHours) === 720, `got ${ovD40.data.nextDurationHours}h`);

  console.log(`\n== 结果：${passed} 通过 / ${failed} 失败 ==`);
  process.exit(failed ? 1 : 0);
}

const mode = process.argv[2];
if (mode === 'seed') await seed();
else if (mode === 'test') await test();
else { console.log('用法: node scripts/match-pool-e2e.mjs [seed|test]'); process.exit(1); }
