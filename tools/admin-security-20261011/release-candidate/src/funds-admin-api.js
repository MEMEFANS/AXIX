import crypto from 'node:crypto';
import { formatUnits } from 'ethers';

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
export function createFundsAdminApi({ walletService, payoutService, send:respond, readBody, isSameOrigin, allowRequest, getToken }) {
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
