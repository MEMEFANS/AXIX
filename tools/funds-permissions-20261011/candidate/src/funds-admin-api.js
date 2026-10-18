import crypto from 'node:crypto';
import { formatUnits, getAddress, parseUnits } from 'ethers';

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,80}$/;
function requestIdOf(body) {
  const requestId = String(body.requestId || '').trim();
  if (!REQUEST_ID.test(requestId)) throw new Error('操作请求编号格式不正确');
  return requestId;
}
function reasonOf(body) {
  const reason = String(body.reason || '').trim().slice(0,120);
  if (reason.length < 2) throw new Error('请填写操作原因');
  return reason;
}
function conflict() {
  return Object.assign(new Error('该请求编号已用于另一笔操作'), { statusCode:409, code:'IDEMPOTENCY_CONFLICT' });
}

function adjustAsset(walletService, body) {
  if (!['grant','debit'].includes(body.action)) throw new Error('资产调整操作无效');
  const asset = body.asset === 'AIX' ? 'A' : String(body.asset || '').toUpperCase();
  if (!['USDT','A'].includes(asset)) throw new Error('仅支持调整 USDT 和 AIX');
  const wallet = getAddress(String(body.wallet || '').trim());
  const requestId = requestIdOf(body), reason = reasonOf(body);
  const decimals = asset === 'A' ? 18 : 6;
  const amount = String(body.amount || '').trim();
  const units = parseUnits(amount,decimals);
  if (units <= 0n) throw new Error('调整数量必须大于 0');
  const type = body.action === 'grant' ? 'funds_grant' : 'funds_debit';
  // The original wallet helper checks only wallet/amount when retrying. Check
  // asset and direction too before delegating to the existing atomic ledger.
  const existing = walletService.database.db.prepare('SELECT wallet,asset,amount_units,adjustment_type FROM balance_adjustments WHERE id=?').get(`adj_${requestId}`);
  if (existing && (existing.wallet.toLowerCase() !== wallet.toLowerCase() || existing.asset !== asset
      || existing.amount_units !== units.toString() || existing.adjustment_type !== type)) throw conflict();
  const input = { wallet, asset, amount, reason, requestId, type };
  return body.action === 'grant' ? walletService.adminCreditAsset(input,'funds-admin')
    : walletService.adminDebitAsset(input,'funds-admin');
}

function grantMiner(walletService, minerService, body) {
  if (!minerService) throw new Error('矿机服务不可用');
  const wallet = getAddress(String(body.wallet || '').trim());
  const requestId = requestIdOf(body), reason = reasonOf(body);
  const plan = String(body.plan || '');
  if (!['mini120','pro1500'].includes(plan)) throw new Error('矿机套餐无效');
  const database = walletService.database;
  const key = `funds_miner_grant:${requestId}`;
  const previous = database.getSetting(key);
  if (previous) {
    const existing = JSON.parse(previous);
    if (existing.wallet.toLowerCase() !== wallet.toLowerCase() || existing.plan !== plan) throw conflict();
    return existing.miner;
  }
  // Establish the wallet before the DB transaction; createMiner and its durable
  // request/audit record then commit together. No balance is credited here.
  walletService.ensureUser(wallet);
  return database.transaction(() => {
    const miner = minerService.createMiner(wallet,plan);
    const record = { wallet, plan, reason, requestId, miner, adminUsername:'funds-admin', createdAt:Date.now() };
    database.saveSetting(key,JSON.stringify(record));
    database.db.prepare('INSERT INTO audit_log(event_id,address,event_type,created_at,payload_json) VALUES(?,?,?,?,?)')
      .run(`funds_miner_${requestId}`,wallet,'funds_miner_grant',record.createdAt,JSON.stringify(record));
    return miner;
  });
}

function listFundsBalanceAdjustments(walletService, limit = 200) {
  const bounded = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const assets = new Map(walletService.publicConfig().assets.map(asset => [asset.symbol, asset]));
  // Remediation audit payloads contain note/rows rather than the normal credit
  // object. Read the canonical ledger columns so those records remain visible.
  return walletService.database.db.prepare(`
    SELECT id,wallet,asset,amount_units,adjustment_type,reason,admin_username,created_at
    FROM balance_adjustments ORDER BY created_at DESC LIMIT ?
  `).all(bounded).map(row => {
    const decimals = assets.get(row.asset)?.decimals;
    const amount = Number.isInteger(decimals) && /^-?\d+$/.test(row.amount_units)
      ? formatUnits(row.amount_units, decimals) : '—';
    return {
      id:row.id, wallet:row.wallet, asset:row.asset, amount, type:row.adjustment_type,
      reason:row.reason, adminUsername:row.admin_username,
      createdAt:new Date(row.created_at).toISOString(),
    };
  });
}

function tokenEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Funds operations require their own bearer credential; operator cookies grant no access.
export function createFundsAdminApi({ walletService, minerService, payoutService, send:respond, readBody, isSameOrigin, allowRequest, getToken }) {
  const send = (res, status, payload) => { respond(res, status, payload); return true; };
  async function handle(request, res, pathname) {
    if (!pathname.startsWith('/api/wallet/admin/')) return false;
    res.setHeader('Cache-Control', 'no-store');
    if (!isSameOrigin(request)) return send(res, 403, { error:'拒绝跨站资金后台请求' });
    if (!allowRequest(request, res, 'funds-admin-access', 120, 60_000)) return true;
    if (!tokenEqual(request.headers['x-wallet-admin-token'], getToken())) {
      return send(res, 401, { error:'资金后台认证失败，请输入独立管理令牌', code:'FUNDS_AUTH_REQUIRED' });
    }
    const url = new URL(request.url, 'http://localhost');
    try {
      if (pathname === '/api/wallet/admin/session' && request.method === 'GET') {
        return send(res, 200, { authenticated:true });
      }
      if (pathname === '/api/wallet/admin/asset-adjustments' && request.method === 'GET') {
        return send(res, 200, { items:listFundsBalanceAdjustments(walletService) });
      }
      if (pathname === '/api/wallet/admin/asset-adjustments' && request.method === 'POST') {
        if (!allowRequest(request,res,'funds-asset-adjust',30,60_000)) return true;
        const body = await readBody(request,16_000);
        return send(res,200,{ ok:true, adjustment:adjustAsset(walletService,body) });
      }
      if (pathname === '/api/wallet/admin/miner-grants' && request.method === 'GET') {
        const rows = walletService.database.db.prepare("SELECT payload_json FROM audit_log WHERE event_type='funds_miner_grant' ORDER BY created_at DESC LIMIT 200").all();
        return send(res,200,{ items:rows.map(row => JSON.parse(row.payload_json)) });
      }
      if (pathname === '/api/wallet/admin/miner-grants' && request.method === 'POST') {
        if (!allowRequest(request,res,'funds-miner-grant',30,60_000)) return true;
        const body = await readBody(request,16_000);
        return send(res,200,{ ok:true, miner:grantMiner(walletService,minerService,body) });
      }
      if (pathname === '/api/wallet/admin/withdrawal-automation' && request.method === 'GET') {
        return send(res, 200, { ...walletService.withdrawalAutomationSettings(), ...payoutService.status() });
      }
      if (pathname === '/api/wallet/admin/withdrawal-automation' && request.method === 'PATCH') {
        const body = await readBody(request, 16_000);
        if (body.enabled === true && !payoutService.status().configured) {
          return send(res, 400, { error:'请先配置出款地址和私钥，再开启自动提现' });
        }
        const settings = walletService.updateWithdrawalAutomationSettings(body);
        if (settings.enabled) payoutService.scan();
        return send(res, 200, { ok:true, ...settings, ...payoutService.status() });
      }
      if (pathname === '/api/wallet/admin/test-credits' && request.method === 'GET') {
        return send(res, 200, { items:listFundsBalanceAdjustments(walletService) });
      }
      if (pathname === '/api/wallet/admin/test-credits' && request.method === 'POST') {
        if (!allowRequest(request, res, 'funds-test-credit', 30, 60_000)) return true;
        const body = await readBody(request, 16_000);
        return send(res, 200, { ok:true, adjustment:walletService.adminCreditTestBalance(body, 'funds-admin') });
      }
      if (pathname === '/api/wallet/admin/withdrawals' && request.method === 'GET') {
        return send(res, 200, { items:walletService.adminListWithdrawals(url.searchParams.get('status') || '') });
      }
      const match = pathname.match(/^\/api\/wallet\/admin\/withdrawals\/([^/]+)$/);
      if (match && request.method === 'POST') {
        if (!allowRequest(request, res, 'funds-withdrawal-review', 30, 60_000)) return true;
        const id = decodeURIComponent(match[1]);
        const body = await readBody(request, 16_000);
        if (!['approve','reject','release','retry'].includes(body.action)) return send(res, 400, { error:'提现审核操作无效' });
        if (['release','retry'].includes(body.action) && !payoutService.status().enabled) {
          return send(res, 503, { error:'自动提现尚未启用，请先配置并开启自动提现' });
        }
        const result = await walletService.adminProcessWithdrawal(id, body);
        if (result.status === 'pending_auto') payoutService.enqueue(result.id).catch(() => {});
        return send(res, 200, result);
      }
      return send(res, 404, { error:'资金后台接口不存在' });
    } catch (error) {
      return send(res, Number(error?.statusCode) || 400, { error:error?.message || '资金操作失败', code:error?.code || 'FUNDS_OPERATION_ERROR' });
    }
  }
  return { handle };
}
