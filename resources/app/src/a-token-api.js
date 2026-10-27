import crypto from 'node:crypto';
import { formatUnits } from 'ethers';
import { createATokenRevenueService } from './a-token-revenue-service.js';
import { activationMessage } from './a-token-activation-service.js';

const A_TOKEN_DECIMALS = 18;
function formatATokenDisplay(units) {
  try { return formatUnits(BigInt(units || '0'), A_TOKEN_DECIMALS); } catch { return '0'; }
}

// A 币前端路由 /api/a-token/*（需钱包 session）
function apiError(message, code = 'A_TOKEN_ERROR', statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}
function errorCode(error) {
  if (error?.code) return error.code;
  const m = String(error?.message || '');
  if (m.includes('余额不足')) return 'INSUFFICIENT_BALANCE';
  if (m.includes('不存在') || m.includes('未找到')) return 'NOT_FOUND';
  if (m.includes('格式') || m.includes('必须') || m.includes('无效') || m.includes('过小')) return 'VALIDATION_ERROR';
  return 'A_TOKEN_ERROR';
}

export function createATokenApi({
  aTokenService, poolService, minerService, stakingService, transferService, activationService, klineService, orderService, withdrawalService, claimService, walletService, teamService,
  send, readBody, getSession, withAccountLock = (addr, op) => op(),
}) {
  const RATE_LIMIT_KEY = 'a-token-mutation';
  const revenueService = createATokenRevenueService({ database: walletService.database });

  function sendError(res, error) {
    send(res, Number(error?.statusCode) || 400, { error: error?.message || String(error), code: errorCode(error) });
  }
  function requireSession(request) {
    const session = getSession(request);
    if (!session) throw apiError('请连接钱包', 'SESSION_REQUIRED', 401);
    return session;
  }
  function idempotencyKey(request) {
    return String(request.headers['idempotency-key'] || `srv_${crypto.randomBytes(12).toString('hex')}`).trim();
  }

  async function handle(request, res, pathname) {
    if (!pathname.startsWith('/api/a-token/')) return false;
    const isGet = request.method === 'GET';

    // 公开（仅需 session）
    if (isGet && pathname === '/api/a-token/pool') {
      try {
        const s = poolService.stats();
        return send(res, 200, { ...s, depth: orderService?.depth?.() || null });
      } catch (e) { return sendError(res, e); }
    }
    // 真实 P2P 盘口（公开）：逐笔列出 OPEN 委托（不归并、不含地址）?limit=20
    if (isGet && pathname === '/api/a-token/orderbook') {
      try {
        const sp = new URLSearchParams(request.url?.split('?')[1] || '');
        const limit = Math.min(Math.max(Number(sp.get('limit')) || 20, 1), 50);
        return send(res, 200, orderService.orderbook({ limit }));
      } catch (e) { return sendError(res, e); }
    }
    // 挂单明细（公开）：逐笔 OPEN 委托（数量 + 金额 + 市价/限价），无挂单时返回空数组
    if (isGet && pathname === '/api/a-token/open-orders') {
      try {
        const sp = new URLSearchParams(request.url?.split('?')[1] || '');
        const limit = Math.min(Math.max(Number(sp.get('limit')) || 50, 1), 2000);
        return send(res, 200, orderService.openOrders({ limit }));
      } catch (e) { return sendError(res, e); }
    }
    if (isGet && pathname === '/api/a-token/plans') {
      const meta = activationService.getMeta ? activationService.getMeta() : {};
      const plans = activationService.getPlans();
      return send(res, 200, {
        activation: plans,
        activationMeta: meta,
        paymentMode: 'aix_balance',
        paymentAsset: 'AIX',
        collectionAddress: '',
        collectionAddressByPlan: {},
        chainId: 56,
        confirmations: Number(process.env.A_TOKEN_ACTIVATION_CONFIRMATIONS || 12),
        activationEnabled: aTokenService.isActivationEnabled ? aTokenService.isActivationEnabled() : true,
        withdrawEnabled: aTokenService.isWithdrawEnabled ? aTokenService.isWithdrawEnabled() : true,
        // 活期已下线（2026-10-25）：套餐列表不再返回 current，前端不再展示入口；历史记录仍可读
        staking: Object.values(stakingService.STAKE_PLANS).filter(p => p.planId !== 'current').map(p => ({ ...p, minUnits: undefined })),
        miner: Object.values(minerService.MINER_PLANS).map(p => ({ ...p, totalUnits: undefined })),
      });
    }
    // K 线（公开）：?period=1m|5m|15m|1h|4h|1d&limit=500
    if (isGet && pathname === '/api/a-token/kline') {
      try {
        const sp = new URLSearchParams(request.url?.split('?')[1] || '');
        const period = String(sp.get('period') || '15m');
        const limit = Number(sp.get('limit') || 500);
        if (klineService?.ensureSeeded) { try { klineService.ensureSeeded(); } catch {} }
        const candles = klineService
          ? klineService.listKlines(period, limit)
          : [];
        return send(res, 200, { period, candles, status: klineService?.status ? klineService.status() : null });
      } catch (e) { return sendError(res, e); }
    }
    // 报价（公开，GET 查询参数）；已登录 → 卖方手续费按直推阶梯费率
    if (isGet && pathname === '/api/a-token/quote') {
      try {
        const sp = new URLSearchParams(request.url?.split('?')[1] || '');
        const side = sp.get('side') === 'sell' ? 'sell' : 'buy';
        const amount = sp.get('amount') || '';
        let quoteWallet = '';
        try { quoteWallet = requireSession(request).address; } catch {}
        return send(res, 200, poolService.quote(side, amount, quoteWallet));
      } catch (e) { return sendError(res, e); }
    }
    // 限价挂单报价（GET 查询参数：side=buy|sell&priceUsdt=0.098&amount=100）
    // 已登录 → 按直推阶梯算卖方手续费；未登录 → 按默认 50% 报价
    if (isGet && pathname === '/api/a-token/orders/quote') {
      try {
        const sp = new URLSearchParams(request.url?.split('?')[1] || '');
        const side = sp.get('side') === 'sell' ? 'sell' : 'buy';
        const priceUsdt = sp.get('priceUsdt') || '';
        const amount = sp.get('amount') || '';
        let quoteWallet = '';
        try { quoteWallet = requireSession(request).address; } catch {}
        return send(res, 200, orderService.quoteLimitOrder({ side, priceUsdt, amount, wallet: quoteWallet }));
      } catch (e) { return sendError(res, e); }
    }

    let session;
    try { session = requireSession(request); }
    catch (e) { return sendError(res, e); }

    try {
      if (isGet && pathname === '/api/a-token/profile') {
        const prof = await aTokenService.profile(session.address);
        // 用 service.present() 的完整字段覆盖（含 remaining/progressPct/label/flexible 等）
        prof.miners = minerService.present(session.address);
        prof.stakes = stakingService.present(session.address);
        // 等级以团队快照为准，不要用 wallet_users 里旧的 level 字段
        prof.level = prof.teamLevel?.level ?? 0;
        // 冻结中资金：OPEN 委托占用的 USDT / A（资产条展示「可用 + 冻结中」）
        try { prof.locked = orderService?.myLocks?.(session.address) || { usdt: '0', a: '0' }; } catch { prof.locked = { usdt: '0', a: '0' }; }
        // 卖出阶梯费率档案（前端下单面板直接展示当前费率）
        try { prof.sellFee = orderService?.sellFeeProfile?.(session.address) || null; } catch { prof.sellFee = null; }
        // 可卖额度（2026-10-25）：只有质押释放的产出可卖，前端卖出面板展示
        try { prof.sellQuota = orderService?.sellQuota?.(session.address) || null; } catch { prof.sellQuota = null; }
        return send(res, 200, prof);
      }
      if (isGet && pathname === '/api/a-token/team/summary') {
        return send(res, 200, teamService.summary(session.address));
      }
      if (isGet && pathname === '/api/a-token/team/profile') {
        try {
          const tp = teamService?.profile(session.address);
          return send(res, 200, tp || { level: 0, levelLabel: '未达标' });
        } catch (e) {
          return send(res, 200, { level: 0, levelLabel: '未达标', error: e?.message || String(e) });
        }
      }
      // AIX 收益流水：汇总矿机产出、质押收益、团队分润、A10 分红、跟单/交易推荐奖励
      if (isGet && pathname === '/api/a-token/revenue') {
        const sp = new URLSearchParams(request.url?.split('?')[1] || '');
        const limit = Number(sp.get('limit') || 100);
        const kind = String(sp.get('kind') || '');
        try {
          const result = revenueService.listRevenue(session.address, { limit, kind });
          return send(res, 200, result);
        } catch (e) { return sendError(res, e); }
      }
      if (isGet && pathname === '/api/a-token/miners') {
        return send(res, 200, { miners: minerService.present(session.address) });
      }
      if (isGet && pathname === '/api/a-token/stakes') {
        return send(res, 200, { stakes: stakingService.present(session.address) });
      }
      if (isGet && pathname === '/api/a-token/my-transfers') {
        return send(res, 200, { transfers: transferService.myTransfers(session.address) });
      }
      // 互转报价预览：GET /api/a-token/transfer-quote?amount=123
      // 返回当前钱包的阶梯手续费率（按直推有效人数）与费用明细
      if (isGet && pathname === '/api/a-token/transfer-quote') {
        const sp = new URLSearchParams(request.url?.split('?')[1] || '');
        return send(res, 200, transferService.quote(session.address, String(sp.get('amount') || '')));
      }
      if (isGet && pathname === '/api/a-token/activations') {
        return send(res, 200, { activations: activationService.listByWallet(session.address) });
      }
      if (isGet && pathname === '/api/a-token/activation-request') {
        const params = new URLSearchParams(request.url?.split('?')[1] || '');
        return send(res, 200, { record: activationService.getRequest(session.address, params.get('plan'), params.get('requestId')) });
      }
      // 我的委托（含 OPEN / FILLED / CANCELLED）
      if (isGet && pathname === '/api/a-token/orders') {
        const sp = new URLSearchParams(request.url?.split('?')[1] || '');
        const limit = Number(sp.get('limit') || 100);
        return send(res, 200, { orders: orderService.myOrders({ wallet: session.address, limit }) });
      }
      // 撤单 DELETE /api/a-token/orders/:orderId
      if (request.method === 'DELETE' && pathname.startsWith('/api/a-token/orders/')) {
        const orderId = decodeURIComponent(pathname.slice('/api/a-token/orders/'.length));
        const result = await withAccountLock(session.address, () => orderService.cancelOrder({ wallet: session.address, orderId, reason: 'user_cancelled' }));
        return send(res, 200, result);
      }
      // A 币链上提现：预估报价 ?amount=100
      if (isGet && pathname === '/api/a-token/withdraw/quote') {
        const sp = new URLSearchParams(request.url?.split('?')[1] || '');
        const amount = Number(sp.get('amount') || 0);
        const balanceA = aTokenService.balanceA(session.address);
        try {
          const q = withdrawalService.quote({ amount });
          return send(res, 200, { ...q, balanceA: formatATokenDisplay(BigInt(balanceA)) });
        } catch (e) { return sendError(res, e); }
      }
      // A 币链上提现：我的提现记录 ?limit=50
      if (isGet && pathname === '/api/a-token/withdrawals') {
        const sp = new URLSearchParams(request.url?.split('?')[1] || '');
        const limit = Number(sp.get('limit') || 50);
        const list = withdrawalService.listWithdrawals(session.address, limit);
        return send(res, 200, {
          withdrawals: list.map(r => ({
            id: r.id, status: r.status, amountA: formatATokenDisplay(BigInt(r.amountUnits || '0')),
            feeA: formatATokenDisplay(BigInt(r.feeUnits || '0')),
            toAddress: r.toAddress || '', txHash: r.txHash || null,
            chainId: r.chainId || 56, confirmations: r.confirmations || 0,
            createdAt: r.createdAt, processedAt: r.processedAt, failReason: r.failReason || null,
          })),
          status: withdrawalService.status(),
        });
      }
      // A 币链上提现：用户撤销 DELETE /api/a-token/withdraw/:id（仅 manual_review/pending 状态可撤销）
      if (request.method === 'DELETE' && pathname.startsWith('/api/a-token/withdraw/')) {
        const withdrawalId = decodeURIComponent(pathname.slice('/api/a-token/withdraw/'.length));
        try {
          const result = await withAccountLock(session.address, () =>
            withdrawalService.cancelWithdrawal({ wallet: session.address, id: withdrawalId }));
          return send(res, 200, result);
        } catch (e) { return sendError(res, e); }
      }

      // ===== AIX 链上提取（AIXPool harvest 模式，用户付 Gas）=====
      // GET /api/a-token/claim/status：返回合约地址、储备量、签名公钥、限额配置
      if (isGet && pathname === '/api/a-token/claim/status') {
        if (!claimService) return send(res, 200, { enabled: false });
        try {
          return send(res, 200, { ...claimService.status(), balanceA: formatATokenDisplay(BigInt(aTokenService.balanceA(session.address) || '0')) });
        } catch (e) { return sendError(res, e); }
      }
      // GET /api/a-token/claims：用户提取记录 ?limit=50
      if (isGet && pathname === '/api/a-token/claims') {
        if (!claimService) return send(res, 200, { claims: [], status: { enabled: false } });
        const sp = new URLSearchParams(request.url?.split('?')[1] || '');
        const limit = Number(sp.get('limit') || 50);
        try {
          const list = claimService.listClaims(session.address, limit);
          return send(res, 200, {
            claims: list.map(r => ({
              id: r.id, status: r.status,
              amountA: formatATokenDisplay(BigInt(r.amountUnits || '0')),
              nonce: r.nonce,
              contractAddress: r.contractAddress,
              txHash: r.txHash || null,
              createdAt: r.createdAt,
              confirmedAt: r.confirmedAt,
              expiresAt: r.expiresAt,
              failReason: r.failReason || null,
            })),
            status: claimService.status(),
          });
        } catch (e) { return sendError(res, e); }
      }

      // 写操作
      if (request.method !== 'POST' && request.method !== 'DELETE') { send(res, 404, { error:'接口不存在', code:'NOT_FOUND' }); return true; }
      if (request.method === 'DELETE') { send(res, 404, { error:'接口不存在', code:'NOT_FOUND' }); return true; }
      // An account freeze covers on-chain exits and transfers to another account.
      if (['/api/a-token/withdraw', '/api/a-token/claim-signature', '/api/a-token/transfer', '/api/a-token/orders'].includes(pathname)
          && walletService.adminGetWithdrawalFreeze?.(session.address)?.frozen) {
        throw apiError('该账户提现与资产转出已冻结，请联系平台客服', 'WITHDRAWAL_FROZEN', 403);
      }
      const body = await readBody(request);

      if (pathname === '/api/a-token/quote') {
        const side = body.side === 'sell' ? 'sell' : 'buy';
        return send(res, 200, poolService.quote(side, String(body.amount ?? '')));
      }
      // 统一下单入口：orderType=market|limit
      //   market 单：{ side:'buy'|'sell', orderType:'market', amount:'100' }  amount=buy时USDT/sell时A
      //   limit 单：{ side:'buy'|'sell', orderType:'limit', priceUsdt:'0.098', amount:'100' }
      if (pathname === '/api/a-token/orders') {
        const side = body.side === 'sell' ? 'sell' : 'buy';
        const orderType = String(body.orderType || 'market').toLowerCase();
        const result = await withAccountLock(session.address, () => orderService.placeOrder({
          wallet: session.address, side, orderType,
          priceUsdt: body.priceUsdt, amount: body.amount,
        }));
        return send(res, 200, result);
      }
      // A 币链上提现：POST /api/a-token/withdraw
      //   body: { amount: '100' }   // toAddress 已废弃：强制只提现到当前连接钱包地址（防钓鱼/防误转）
      //   幂等键：header 'idempotency-key'
      if (pathname === '/api/a-token/withdraw') {
        if (aTokenService.isWithdrawEnabled && !aTokenService.isWithdrawEnabled()) {
          return send(res, 503, { error: 'AIX 提现暂未开放，请留意平台公告', code: 'WITHDRAW_DISABLED' });
        }
        const requestId = idempotencyKey(request);
        // 钱包签名确认：AIX 提现必须由用户本人钱包 personal_sign 授权（签名绑定幂等编号防重放）
        walletService.verifyOperationSignature({
          address: session.address,
          message: `AxiX AIX提现确认：数量 ${String(body.amount ?? '')} AIX，编号 ${requestId}，时间：${String(body.timestamp ?? '')}`,
          signature: String(body.signature ?? ''),
        });
        try {
          const result = await withAccountLock(session.address, () => withdrawalService.requestWithdrawal({
            wallet: session.address,
            amount: String(body.amount ?? ''),
            toAddress: session.address, // 强制等于连接钱包
            requestId,
          }));
          return send(res, 200, {
            ok: true,
            withdrawal: {
              id: result.id, status: result.status,
              amountA: formatATokenDisplay(BigInt(result.amountUnits || '0')),
              feeA: formatATokenDisplay(BigInt(result.feeUnits || '0')),
              toAddress: result.toAddress, txHash: result.txHash,
              createdAt: result.createdAt,
              autoApproved: result.status === 'processing',
              needManualReview: result.status === 'manual_review',
            },
          });
        } catch (e) { return sendError(res, e); }
      }
      // AIX 链上提取签名：POST /api/a-token/claim-signature
      //   body: { amount: '100' }
      //   返回 { claimId, amount, amountUnits, nonce, signature, contractAddress, chainId, expiresAt }
      //   前端拿到 signature + nonce 后调用 AIXPool.harvest(amountUnits, nonceBigInt, signature)
      if (pathname === '/api/a-token/claim-signature') {
        if (!claimService) return sendError(res, apiError('AIX 链上提取未启用', 'CLAIM_NOT_ENABLED', 503));
        try {
          const result = await withAccountLock(session.address, () => claimService.signClaim({
            wallet: session.address,
            amount: String(body.amount ?? ''),
          }));
          return send(res, 200, { ok: true, claim: {
            claimId: result.claimId,
            amount: result.amount,
            amountUnits: result.amountUnits,
            nonce: result.nonce,
            nonceBigInt: '0x' + result.nonce,
            signature: result.signature,
            contractAddress: result.contractAddress,
            chainId: result.chainId,
            expiresAt: result.expiresAt,
          }});
        } catch (e) { return sendError(res, e); }
      }
      // AIX 链上提取确认：POST /api/a-token/claim-confirm
      //   body: { claimId, txHash }
      if (pathname === '/api/a-token/claim-confirm') {
        if (!claimService) return sendError(res, apiError('AIX 链上提取未启用', 'CLAIM_NOT_ENABLED', 503));
        try {
          const result = await claimService.confirmClaim({
            wallet: session.address,
            claimId: String(body.claimId || ''),
            txHash: String(body.txHash || ''),
          });
          return send(res, 200, { ok: true, claim: {
            id: result.id, status: result.status,
            txHash: result.txHash,
            confirmedAt: result.confirmedAt,
          }});
        } catch (e) { return sendError(res, e); }
      }
      // AIX 链上提取退款（用户取消签名或链上失败）：POST /api/a-token/claim-refund
      //   body: { claimId, reason? }
      if (pathname === '/api/a-token/claim-refund') {
        if (!claimService) return sendError(res, apiError('AIX 链上提取未启用', 'CLAIM_NOT_ENABLED', 503));
        try {
          const result = await withAccountLock(session.address, () => claimService.refundClaim(
            String(body.claimId || ''),
            String(body.reason || 'user_cancelled'),
          ));
          return send(res, 200, { ok: true, claim: {
            id: result.id, status: result.status, failReason: result.failReason,
          }});
        } catch (e) { return sendError(res, e); }
      }
      if (pathname === '/api/a-token/transfer') {
        const requestId = idempotencyKey(request);
        // 钱包签名确认：互转必须由用户本人钱包 personal_sign 授权（签名绑定幂等编号防重放）
        walletService.verifyOperationSignature({
          address: session.address,
          message: `AxiX 互转确认：数量 ${String(body.amount ?? '')} AIX，收款方 ${String(body.toUserId ?? '')}，编号 ${requestId}，时间：${String(body.timestamp ?? '')}`,
          signature: String(body.signature ?? ''),
        });
        const result = await withAccountLock(session.address, () => transferService.transferByUserId(session.address, String(body.toUserId ?? ''), String(body.amount ?? ''), requestId));
        return send(res, 200, result);
      }
      if (pathname === '/api/a-token/stake') {
        const result = await withAccountLock(session.address, () => stakingService.stake(session.address, String(body.planId ?? ''), String(body.principal ?? '')));
        return send(res, 200, { ok:true, stake:result });
      }
      if (pathname === '/api/a-token/unstake') {
        const result = await withAccountLock(session.address, () => stakingService.unstake(session.address, String(body.stakeId ?? '')));
        return send(res, 200, { ok:true, stake:result });
      }
      if (pathname === '/api/a-token/activate') {
        // Cached clients may only recover BNB payments made before the cutover.
        if (body.txHash) {
          const record = await withAccountLock(session.address, () => activationService.submit(session.address, String(body.plan ?? ''), String(body.txHash)));
          const verified = await activationService.verify(record);
          return send(res, 200, { ok: true, activation: verified });
        }
        const requestId = String(request.headers['idempotency-key'] || '').trim();
        const planKey = String(body.plan ?? '');
        let quantity = Math.floor(Number(body.quantity));
        if (!Number.isFinite(quantity) || quantity < 1) quantity = 1;
        if (quantity > 100) throw apiError('单次最多激活 100 台，请分批操作', 'VALIDATION_ERROR');
        const result = await withAccountLock(session.address, () => {
          const previous = activationService.getRequest(session.address, planKey, requestId);
          if (previous) return previous;
          walletService.verifyOperationSignature({ address: session.address,
            message: activationMessage(planKey, requestId, String(body.timestamp ?? ''), quantity),
            signature: String(body.signature ?? '') });
          return activationService.activate(session.address, planKey, requestId, quantity);
        });
        return send(res, 200, { ok: true, activation: { status: result.status, record: result } });
      }

      send(res, 404, { error:'接口不存在', code:'NOT_FOUND' });
      return true;
    } catch (error) {
      sendError(res, error);
      return true;
    }
  }

  return { handle };
}
