// 积分抽奖 API：/api/lottery/*
export function createLotteryApi({ lotteryService, send, readBody, getSession, adminOnly }) {
  function sendError(res, error) {
    send(res, Number(error?.statusCode) || 400, { error: error?.message || String(error) });
  }
  function requireSession(request) {
    const session = getSession(request);
    if (!session) { send(res, 401, { error: '请连接钱包' }); return null; }
    return session;
  }

  async function handle(request, res, pathname) {
    if (!pathname.startsWith('/api/lottery/') && !pathname.startsWith('/api/admin/lottery/')) return false;
    const isGet = request.method === 'GET';
    const isPost = request.method === 'POST';

    // 公开配置
    if (isGet && pathname === '/api/lottery/config') {
      try { return send(res, 200, lotteryService.getConfig()); }
      catch (e) { return sendError(res, e); }
    }

    // 我的积分
    if (isGet && pathname === '/api/lottery/points') {
      const session = requireSession(request); if (!session) return true;
      try {
        return send(res, 200, {
          points: lotteryService.getPoints(session.address),
          flows: lotteryService.listFlows(session.address, 30),
        });
      } catch (e) { return sendError(res, e); }
    }

    // 抽奖（单次）
    if (isPost && pathname === '/api/lottery/draw') {
      const session = requireSession(request); if (!session) return true;
      try {
        const win = lotteryService.draw(session.address);
        return send(res, 200, { win });
      } catch (e) { return sendError(res, e); }
    }

    // 10 连抽
    if (isPost && pathname === '/api/lottery/draw-ten') {
      const session = requireSession(request); if (!session) return true;
      try {
        const wins = lotteryService.drawTen(session.address);
        return send(res, 200, { wins });
      } catch (e) { return sendError(res, e); }
    }

    // 我的中奖记录
    if (isGet && pathname === '/api/lottery/wins') {
      const session = requireSession(request); if (!session) return true;
      try { return send(res, 200, { wins: lotteryService.listWins(session.address, 50) }); }
      catch (e) { return sendError(res, e); }
    }

    // 填写实物收件地址
    if (isPost && pathname.startsWith('/api/lottery/wins/') && pathname.endsWith('/address')) {
      const session = requireSession(request); if (!session) return true;
      try {
        const id = pathname.split('/')[4];
        const body = await readBody(request);
        const payload = typeof body === 'string' ? JSON.parse(body) : body;
        const win = lotteryService.submitAddress(id, session.address, payload);
        return send(res, 200, { win });
      } catch (e) { return sendError(res, e); }
    }

    // 滚动中奖公告
    if (isGet && pathname === '/api/lottery/recent') {
      try { return send(res, 200, { wins: lotteryService.recentWins(50) }); }
      catch (e) { return sendError(res, e); }
    }

    // 价值排行榜
    if (isGet && pathname === '/api/lottery/leaderboard') {
      try {
        const sp = new URLSearchParams(request.url?.split('?')[1] || '');
        const days = Number(sp.get('days')) || 7;
        return send(res, 200, { wins: lotteryService.leaderboard(days, 20) });
      } catch (e) { return sendError(res, e); }
    }

    // 提交社交推广
    if (isPost && pathname === '/api/lottery/social/submit') {
      const session = requireSession(request); if (!session) return true;
      try {
        const body = await readBody(request);
        const payload = typeof body === 'string' ? JSON.parse(body) : body;
        const sub = lotteryService.submitSocial(session.address, payload.platform, payload.screenshotUrl);
        return send(res, 200, { submission: sub });
      } catch (e) { return sendError(res, e); }
    }

    // 查询社交提交状态
    if (isGet && pathname === '/api/lottery/social/status') {
      const session = requireSession(request); if (!session) return true;
      try {
        return send(res, 200, {
          canTwitter: lotteryService.canSubmitSocial(session.address, 'twitter'),
          canMoments: lotteryService.canSubmitSocial(session.address, 'moments'),
        });
      } catch (e) { return sendError(res, e); }
    }

    // ── 后台管理 ──────────────────────────────────────────────────
    // 社交审核列表
    if (isGet && pathname === '/api/admin/lottery/social') {
      if (!adminOnly(request, res)) return true;
      try {
        const sp = new URLSearchParams(request.url?.split('?')[1] || '');
        const status = sp.get('status') || '';
        return send(res, 200, { list: lotteryService.adminListSocial(status, 200) });
      } catch (e) { return sendError(res, e); }
    }

    // 审核社交提交
    if (isPost && pathname.startsWith('/api/admin/lottery/social/') && pathname.endsWith('/review')) {
      if (!adminOnly(request, res)) return true;
      try {
        const id = pathname.split('/')[5];
        const body = await readBody(request);
        const payload = typeof body === 'string' ? JSON.parse(body) : body;
        const sub = lotteryService.adminReviewSocial(id, !!payload.approve, payload.reviewer || 'admin');
        return send(res, 200, { submission: sub });
      } catch (e) { return sendError(res, e); }
    }

    // 实物奖发货列表
    if (isGet && pathname === '/api/admin/lottery/physical') {
      if (!adminOnly(request, res)) return true;
      try {
        const sp = new URLSearchParams(request.url?.split('?')[1] || '');
        const status = sp.get('status') || '';
        return send(res, 200, { list: lotteryService.adminListPhysicalWins(status, 200) });
      } catch (e) { return sendError(res, e); }
    }

    // 发货
    if (isPost && pathname.startsWith('/api/admin/lottery/physical/') && pathname.endsWith('/ship')) {
      if (!adminOnly(request, res)) return true;
      try {
        const id = pathname.split('/')[5];
        const body = await readBody(request);
        const payload = typeof body === 'string' ? JSON.parse(body) : body;
        const win = lotteryService.adminShipWin(id, payload.trackingNo || '', payload.operator || 'admin');
        return send(res, 200, { win });
      } catch (e) { return sendError(res, e); }
    }

    // 指定中奖列表
    if (isGet && pathname === '/api/admin/lottery/assigned') {
      if (!adminOnly(request, res)) return true;
      try {
        const sp = new URLSearchParams(request.url?.split('?')[1] || '');
        const status = sp.get('status') || 'pending';
        return send(res, 200, { list: lotteryService.adminListAssigned(status, 200) });
      } catch (e) { return sendError(res, e); }
    }

    // 添加指定中奖
    if (isPost && pathname === '/api/admin/lottery/assigned') {
      if (!adminOnly(request, res)) return true;
      try {
        const body = await readBody(request);
        const payload = typeof body === 'string' ? JSON.parse(body) : body;
        const assigned = lotteryService.adminAssignWin(payload.wallet, payload.prizeId, Number(payload.amount) || 0, payload.note || '', payload.operator || 'admin');
        return send(res, 200, { assigned });
      } catch (e) { return sendError(res, e); }
    }

    // 删除指定中奖
    if (isPost && pathname.startsWith('/api/admin/lottery/assigned/') && pathname.endsWith('/delete')) {
      if (!adminOnly(request, res)) return true;
      try {
        const id = pathname.split('/')[5];
        const r = lotteryService.adminDeleteAssigned(id);
        return send(res, 200, { deleted: r });
      } catch (e) { return sendError(res, e); }
    }

    // 后台充值积分
    if (isPost && pathname === '/api/admin/lottery/points') {
      if (!adminOnly(request, res)) return true;
      try {
        const body = await readBody(request);
        const payload = typeof body === 'string' ? JSON.parse(body) : body;
        const wallet = String(payload.wallet || '').trim();
        const points = Math.floor(Number(payload.points));
        if (!wallet) throw new Error('请填写钱包地址');
        if (!Number.isFinite(points) || points <= 0) throw new Error('积分数量必须为正整数');
        lotteryService.addPoints(wallet, points, 'admin_topup', '', payload.note || '后台充值');
        return send(res, 200, { balance: lotteryService.getPoints(wallet) });
      } catch (e) { return sendError(res, e); }
    }

    // 奖品概率配置（读取）
    if (isGet && pathname === '/api/admin/lottery/prizes') {
      if (!adminOnly(request, res)) return true;
      try {
        return send(res, 200, lotteryService.adminGetPrizeConfig());
      } catch (e) { return sendError(res, e); }
    }

    // 奖品概率配置（保存，单位 %，总和必须 100）
    if (isPost && pathname === '/api/admin/lottery/prizes') {
      if (!adminOnly(request, res)) return true;
      try {
        const body = await readBody(request);
        const payload = typeof body === 'string' ? JSON.parse(body) : body;
        const result = lotteryService.adminSetPrizeProbabilities(payload.probabilities || {}, payload.operator || 'admin');
        return send(res, 200, result);
      } catch (e) { return sendError(res, e); }
    }

    // 币奖价值区间配置（保存；{ id: {min,max} } 设置，{ id: null } 恢复默认）
    if (isPost && pathname === '/api/admin/lottery/prize-amounts') {
      if (!adminOnly(request, res)) return true;
      try {
        const body = await readBody(request);
        const payload = typeof body === 'string' ? JSON.parse(body) : body;
        const result = lotteryService.adminSetPrizeAmounts(payload.amounts || {}, payload.operator || 'admin');
        return send(res, 200, result);
      } catch (e) { return sendError(res, e); }
    }

    return false;
  }

  return { handle };
}
