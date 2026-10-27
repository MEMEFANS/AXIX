import { isLegacyFundsPath } from './admin-security.js';

// A 币后台路由 /api/admin/a-token/*（需后台 operator session,由 server.js 在 admin 块内调用）
export function createATokenAdminApi({
  aTokenService, poolService, minerService, stakingService, activationService, klineService, orderService, walletService,
  aTokenTeamService,
  send, readBody,
}) {
  async function handle(request, res, pathname, ctx = {}) {
    if (!pathname.startsWith('/api/admin/a-token/')) return false;
    // Also enforce this inside the router so a future caller cannot bypass the
    // server's operator guard. Funds credentials only work on the funds API.
    if (isLegacyFundsPath(pathname)) {
      send(res, 403, { error:'此操作需要独立资金后台权限', code:'FUNDS_ADMIN_REQUIRED' });
      return true;
    }
    const { url, allowRequest } = ctx;
    const searchParams = url?.searchParams;

    try {
      if (pathname === '/api/admin/a-token/stats' && request.method === 'GET') {
        return send(res, 200, {
          pool: aTokenService.poolStats(),
          activation: aTokenService.getActivationMeta(),
          orders: orderService?.stats?.() || null,
          miners: aTokenTeamService?.reportingMinerSummary?.() || walletService.database?.adminMinerSummary?.() || null,
        });
      }
      // 挂单查询（所有钱包）?status=OPEN|FILLED|CANCELLED&wallet=...&limit=500
      if (pathname === '/api/admin/a-token/orders' && request.method === 'GET') {
        const status = String(searchParams?.get('status') || '').trim();
        const wallet = String(searchParams?.get('wallet') || '').trim();
        const limit = Math.max(1, Math.min(1000, Number(searchParams?.get('limit') || 500)));
        const source = wallet
          ? walletService.database?.listATokenOrdersByWallet?.(wallet, limit) || []
          : (status
              ? (walletService.database?.listATokenOpenOrders?.() || []).filter(r => r.status === status)
              : (walletService.database?.listATokenOpenOrders?.() || []));
        return send(res, 200, {
          items: source,
          stats: orderService?.stats?.() || null,
        });
      }
      // 后台强制撤单（按 orderId，可指定 reason）
      if (request.method === 'POST' && pathname === '/api/admin/a-token/orders/cancel') {
        const body = await readBody(request);
        const orderId = String(body.orderId || '').trim();
        const reason = String(body.reason || 'admin_cancelled').slice(0, 120);
        const order = walletService.database?.getATokenOrder?.(orderId);
        if (!order) return send(res, 404, { error: '订单不存在' });
        if (order.status !== 'OPEN') return send(res, 400, { error: '仅 OPEN 状态订单可撤单' });
        // 解冻
        const wallet = String(order.wallet || '').toLowerCase();
        if (BigInt(order.input_usdt_units || '0') > 0n) aTokenService.creditUsdt(wallet, BigInt(order.input_usdt_units));
        if (BigInt(order.input_a_units || '0') > 0n) {
          aTokenService.creditA(wallet, BigInt(order.input_a_units));
          // 2026-10-25：后台撤卖单时返还已占用的可卖额度
          try { walletService.database?.refundATokenSellQuota?.(wallet, BigInt(order.input_a_units)); } catch {}
        }
        const now = Date.now();
        const info = walletService.database?.markATokenOrderCancelled?.(orderId, { cancelledAt: now, updatedAt: now, reason });
        return send(res, 200, { ok: true, changes: info?.changes || 0 });
      }

      // 激活管理
      if (pathname === '/api/admin/a-token/activations' && request.method === 'GET') {
        const status = String(searchParams?.get('status') || '').trim();
        const all = activationService.listAll(500);
        const items = status ? all.filter(r => r.status === status) : all;
        return send(res, 200, { items });
      }
      if (request.method === 'POST' && pathname === '/api/admin/a-token/activations/verify') {
        if (allowRequest && !allowRequest(request, res, 'a-token-admin', 30, 60_000)) return true;
        const body = await readBody(request);
        const record = activationService.findById(String(body.id || ''));
        if (!record) return send(res, 404, { error:'激活记录不存在' });
        const result = await activationService.verify(record);
        return send(res, 200, { ok:true, activation: result });
      }
      if (request.method === 'POST' && pathname === '/api/admin/a-token/activations/reject') {
        const body = await readBody(request);
        return send(res, 200, { ok:true, activation: activationService.adminReject(String(body.id || ''), String(body.reason || '')) });
      }

      // ── 平台公告（公开接口 /api/announcement 只读；此处可写，最多 2 条）──
      if (request.method === 'POST' && pathname === '/api/admin/a-token/announcement') {
        if (allowRequest && !allowRequest(request, res, 'a-token-admin', 30, 60_000)) return true;
        const body = await readBody(request);
        let prev = null;
        try { prev = JSON.parse(walletService.database.getSetting('platform_announcement') || 'null'); } catch { prev = null; }
        const prevList = Array.isArray(prev) ? prev : (prev && typeof prev === 'object' ? [prev] : []);
        const rawItems = Array.isArray(body.items) ? body.items : [body];
        const items = rawItems.slice(0, 2).map((ann, i) => {
          const id = String(ann?.id || `a${i + 1}`);
          const next = {
            id,
            enabled: ann?.enabled === true || ann?.enabled === '1' || ann?.enabled === 1,
            zh: String(ann?.zh ?? '').slice(0, 2000),
            en: String(ann?.en ?? '').slice(0, 2000),
          };
          const old = prevList.find(row => String(row?.id || '') === id);
          const changed = !old || old.enabled !== next.enabled
            || String(old.zh || '') !== next.zh || String(old.en || '') !== next.en;
          // 只有内容真的变了才刷新 updatedAt：否则编辑第二条会把已关闭的第一条重新弹出来
          return { ...next, updatedAt: changed ? Date.now() : (Number(old?.updatedAt) || 0) };
        });
        walletService.database.saveSetting('platform_announcement', JSON.stringify(items));
        const head = items.find(item => item.enabled) || items[0] || { enabled:false, zh:'', en:'', updatedAt:0 };
        return send(res, 200, {
          ok: true, items,
          enabled: head.enabled, zh: head.zh, en: head.en, updatedAt: head.updatedAt,
        });
      }

      // 价格 / 手续费 / 交易数据调控
      if (request.method === 'POST' && pathname === '/api/admin/a-token/price') {
        const body = await readBody(request);
        aTokenService.setPrice(String(body.price ?? ''));
        // 后台改价后立即触发一次限价单撮合
        let matchResult = null;
        try { matchResult = orderService?.matchOpenOrders?.() || null; } catch (e) { matchResult = { error: e?.message || String(e) }; }
        return send(res, 200, { ok:true, pool: aTokenService.poolStats(), orderMatch: matchResult });
      }
      if (request.method === 'POST' && pathname === '/api/admin/a-token/pool-meta') {
        const body = await readBody(request);
        const patch = {};
        if (body.feeRateBps !== undefined) patch.feeRateBps = Math.max(0, Math.min(10000, Number(body.feeRateBps) || 0));
        if (body.burnRateBps !== undefined) patch.burnRateBps = Math.max(0, Math.min(10000, Number(body.burnRateBps) || 0));
        if (body.dividendRateBps !== undefined) patch.dividendRateBps = Math.max(0, Math.min(10000, Number(body.dividendRateBps) || 0));
        if (body.adminOverrides !== undefined) patch.adminOverrides = body.adminOverrides || {};
        if (body.todayVolumeA !== undefined) patch.todayVolumeAUnits = String(body.todayVolumeA); // 后台调控今日交易量
        if (body.todayVolumeUsdt !== undefined) patch.todayVolumeUsdtUnits = String(body.todayVolumeUsdt);
        aTokenService.setPoolMeta(patch);
        return send(res, 200, { ok:true, pool: aTokenService.poolStats() });
      }

      // ── 销毁总开关 ──
      if (request.method === 'POST' && pathname === '/api/admin/a-token/burn/mode') {
        if (allowRequest && !allowRequest(request, res, 'a-token-admin', 30, 60_000)) return true;
        const body = await readBody(request);
        const enabled = body.enabled === true || body.enabled === '1' || body.enabled === 1;
        aTokenService.setPoolMeta({ burnEnabled: enabled ? '1' : '0' });
        return send(res, 200, { ok:true, burnEnabled: enabled, pool: aTokenService.poolStats() });
      }

      // ── 活期质押下线退款（2026-10-25）：所有 active 活期质押一次性退本金、停止产出 ──
      if (request.method === 'POST' && pathname === '/api/admin/a-token/staking/refund-flexible') {
        if (allowRequest && !allowRequest(request, res, 'a-token-admin', 30, 60_000)) return true;
        const result = stakingService.refundAllFlexible();
        return send(res, 200, { ok: true, ...result });
      }

      // ── 全部质押退回（2026-10-25）：所有在架质押（含固定档）退还剩余未返还本金、停止产出，之后按新规则重开 ──
      if (request.method === 'POST' && pathname === '/api/admin/a-token/staking/refund-all') {
        if (allowRequest && !allowRequest(request, res, 'a-token-admin', 30, 60_000)) return true;
        const result = stakingService.refundAllStakes();
        return send(res, 200, { ok: true, ...result });
      }

      // ── 矿机激活开关（关闭时用户不可激活矿机）──
      if (request.method === 'POST' && pathname === '/api/admin/a-token/activation/mode') {
        if (allowRequest && !allowRequest(request, res, 'a-token-admin', 30, 60_000)) return true;
        const body = await readBody(request);
        const enabled = body.enabled === true || body.enabled === '1' || body.enabled === 1;
        aTokenService.setPoolMeta({ activationEnabled: enabled ? '1' : '0' });
        return send(res, 200, { ok:true, activationEnabled: enabled, pool: aTokenService.poolStats() });
      }

      // ── 矿机激活名额进度（前台「激活名额进度」进度条展示值可调）──
      if (request.method === 'POST' && pathname === '/api/admin/a-token/activation/progress') {
        if (allowRequest && !allowRequest(request, res, 'a-token-admin', 30, 60_000)) return true;
        const body = await readBody(request);
        const patch = {};
        if (body.cap !== undefined) patch.cap = body.cap;
        if (body.activatedCount !== undefined) patch.activatedCount = body.activatedCount;
        const activationMeta = aTokenService.setActivationMeta(patch);
        return send(res, 200, { ok:true, activationMeta });
      }

      // ── AIX 提现开关（关闭时用户不可发起 AIX 链上提现）──
      if (request.method === 'POST' && pathname === '/api/admin/a-token/withdraw/mode') {
        if (allowRequest && !allowRequest(request, res, 'a-token-admin', 30, 60_000)) return true;
        const body = await readBody(request);
        const enabled = body.enabled === true || body.enabled === '1' || body.enabled === 1;
        aTokenService.setPoolMeta({ withdrawEnabled: enabled ? '1' : '0' });
        return send(res, 200, { ok:true, withdrawEnabled: enabled, pool: aTokenService.poolStats() });
      }

      // ── K 线调控 ──
      if (klineService && pathname === '/api/admin/a-token/kline/status' && request.method === 'GET') {
        return send(res, 200, { ok:true, status: klineService.status(), pool: aTokenService.poolStats() });
      }
      if (klineService && request.method === 'POST' && pathname === '/api/admin/a-token/kline/mode') {
        if (allowRequest && !allowRequest(request, res, 'a-token-admin', 30, 60_000)) return true;
        const body = await readBody(request);
        const patch = {};
        if (['sideways','up','down','daily','manual'].includes(body.mode)) patch.mode = body.mode;
        if (body.volatility !== undefined) patch.volatility = Math.max(0.1, Math.min(5, Number(body.volatility) || 1));
        if (body.baseVolumePerDayA !== undefined) patch.baseVolumePerDayA = Math.max(0, Number(body.baseVolumePerDayA) || 0);
        // daily 模式：每日目标涨跌幅（%），正=涨 负=跌
        if (body.dailyChangePct !== undefined) {
          const v = Number(body.dailyChangePct);
          if (!Number.isFinite(v)) throw new Error('每日涨跌幅必须是数字（如 1 表示每日 +1%）');
          patch.dailyChangePct = Math.max(-95, Math.min(95, v));
          // 中途改涨幅必须重锚当日计划（以当前价为起点重新规划），
          // 否则旧锚点 + 新目标会让路径输出与现价差出好几个百分点，
          // tick 被 ±0.3% 硬限幅顶格 → K 线出现匀速直线拉升（2026-10-21 事故）
          patch.daily = null;
        }
        if (body.driftBpsPer1m && typeof body.driftBpsPer1m === 'object') {
          const drift = {};
          for (const k of ['sideways','up','down']) {
            if (body.driftBpsPer1m[k] !== undefined) drift[k] = Number(body.driftBpsPer1m[k]) || 0;
          }
          patch.driftBpsPer1m = drift;
        }
        const settings = klineService.saveSettings(patch);
        return send(res, 200, { ok:true, settings });
      }
      if (klineService && request.method === 'POST' && pathname === '/api/admin/a-token/kline/rebuild') {
        if (allowRequest && !allowRequest(request, res, 'a-token-admin', 2, 60_000)) return true;
        const body = await readBody(request);
        const info = klineService.rebuildAll(body.basePrice);
        return send(res, 200, { ok:true, rebuilt: info });
      }
      if (klineService && request.method === 'POST' && pathname === '/api/admin/a-token/kline/append') {
        if (allowRequest && !allowRequest(request, res, 'a-token-admin', 30, 60_000)) return true;
        const body = await readBody(request);
        const period = String(body.period || '1m');
        const candle = klineService.appendCandle(period, body.candle || {});
        return send(res, 200, { ok:true, candle, period });
      }
      if (klineService && request.method === 'POST' && pathname === '/api/admin/a-token/kline/tick') {
        if (allowRequest && !allowRequest(request, res, 'a-token-admin', 60, 60_000)) return true;
        const body = await readBody(request);
        const n = Math.max(1, Math.min(120, Number(body?.n || 1)));
        const results = [];
        for (let i = 0; i < n; i++) results.push(klineService.tickLiveBar());
        return send(res, 200, { ok:true, ticks: results.length, last: results[results.length - 1] });
      }

      // ── 矿机管理 ──
      // 列表 ?wallet= &status= &plan= &limit=500
      if (pathname === '/api/admin/a-token/miners' && request.method === 'GET') {
        const wallet = String(searchParams?.get('wallet') || '').trim();
        const status = String(searchParams?.get('status') || '').trim();
        const plan = String(searchParams?.get('plan') || '').trim();
        const limit = Math.max(1, Math.min(2000, Number(searchParams?.get('limit') || 500)));
        const items = minerService.presentAll({ wallet, status, plan, limit });
        return send(res, 200, {
          items,
          activationMeta: aTokenService.getActivationMeta(),
          summary: aTokenTeamService?.reportingMinerSummary?.() || walletService.database?.adminMinerSummary?.() || null,
          today: walletService.database?.adminMinerTodaySummary?.() || null,
          plans: Object.keys(minerService.MINER_PLANS || {}).map(k => ({
            id: k, days: minerService.MINER_PLANS[k].days,
            dailyTarget: minerService.dailyTargetOf(k).toString(),
          })),
        });
      }
      // 手动发放（补齐截至当前未入账的产出）
      if (request.method === 'POST' && pathname === '/api/admin/a-token/miners/release') {
        if (allowRequest && !allowRequest(request, res, 'a-token-admin', 30, 60_000)) return true;
        const body = await readBody(request);
        const minerId = String(body.minerId || '').trim();
        const result = minerService.releaseNowById(minerId);
        if (!result) return send(res, 404, { error: '矿机不存在或已不是 active 状态' });
        return send(res, 200, { ok: true, ...result });
      }
      // 强制过期（默认补齐尾差，也可以不补）
      if (request.method === 'POST' && pathname === '/api/admin/a-token/miners/expire') {
        if (allowRequest && !allowRequest(request, res, 'a-token-admin', 30, 60_000)) return true;
        const body = await readBody(request);
        const minerId = String(body.minerId || '').trim();
        const payRemaining = body.payRemaining !== false; // 默认 true
        const miner = minerService.forceExpire(minerId, { payRemaining });
        if (!miner) return send(res, 404, { error: '矿机不存在' });
        return send(res, 200, { ok: true, miner });
      }
      // 批量处理所有 active 矿机（立刻跑一轮产出，不等 60s 定时器）
      if (request.method === 'POST' && pathname === '/api/admin/a-token/miners/process-all') {
        if (allowRequest && !allowRequest(request, res, 'a-token-admin', 30, 60_000)) return true;
        const processed = minerService.processAll();
        return send(res, 200, { ok: true, processed });
      }

      // 团队激活查询：?address=0x...&exclude=0x...,0x...
      // 统计该地址整棵下线（团队）的 mini120/pro1500 激活数，并返回按直推拆分的明细，
      // 便于运维自行选择排除某个直推（排除其本人及其整棵子树）后查看净数。
      if (pathname === '/api/admin/a-token/team-activations' && request.method === 'GET') {
        const address = String(searchParams?.get('address') || '').trim().toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(address)) return send(res, 400, { error:'请输入正确的钱包地址（0x 开头 42 位）' });
        if (!aTokenTeamService?.teamActivationBreakdown) return send(res, 500, { error:'团队统计服务未就绪' });
        const exclude = String(searchParams?.get('exclude') || '').split(',').map(s => s.trim()).filter(Boolean);
        return send(res, 200, aTokenTeamService.teamActivationBreakdown(address, exclude));
      }

      // 用户列表（含 A 余额）
      if (pathname === '/api/admin/a-token/users' && request.method === 'GET') {
        const dashboard = walletService.adminDashboard();
        const users = (dashboard.users || []).map(u => ({
          address: u.address, USDT: u.USDT, A: u.balances?.A ?? u.A ?? '0', updatedAt: u.updatedAt,
        }));
        return send(res, 200, { summary: dashboard.summary, users });
      }

      send(res, 404, { error:'后台接口不存在', code:'NOT_FOUND' });
      return true;
    } catch (error) {
      return send(res, Number(error?.statusCode) || 400, { error: error?.message || String(error), code: error?.code || 'A_TOKEN_ADMIN_ERROR' });
    }
  }

  return { handle };
}
