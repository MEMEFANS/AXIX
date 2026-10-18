(function () {
  const byId = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  })[char]);
  const amount = value => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:6 });
  const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12:false }) : '-';
  const shortAddress = value => {
    const text = String(value || '');
    return text.length > 18 ? `${text.slice(0, 8)}...${text.slice(-6)}` : text || '-';
  };
  const statusText = {
    pending:'待确认', confirmed:'已确认', rejected:'已拒绝', expired:'已过期',
    pending_review:'待人工审核', pending_funds:'待补款放行', pending_auto:'自动队列', processing:'准备出款', signed:'等待广播',
    broadcast:'链上确认中', payout_failed:'出款失败', paid:'已支付', failed:'失败', refunded:'失败已退回',
  };
  const statusClass = status => ['confirmed', 'paid', 'refunded'].includes(status) ? 'good'
    : ['pending', 'pending_review', 'pending_funds', 'pending_auto', 'processing', 'signed', 'broadcast'].includes(status) ? 'warn'
      : ['rejected', 'expired', 'failed', 'payout_failed'].includes(status) ? 'bad' : '';

  let currentPage = 'overview';
  let dashboard = { summary:{}, users:[], tokens:[], recentDeposits:[], recentWithdrawals:[] };
  let deposits = [];
  const USER_PAGE_SIZE = 50;
  let usersOffset = 0, usersTotal = 0, usersRequestSeq = 0, overviewRequestSeq = 0, depositsRequestSeq = 0, minerRequestSeq = 0, klineRequestSeq = 0;
  let adminGeneration = 0, userSearchTimer = null;
  const pendingReads = new Map();

  function setLoginError(message = '') { byId('admin-login-error').textContent = message; }
  function toast(message = '') {
    const node = byId('admin-global-status');
    node.textContent = message;
    node.classList.toggle('show', Boolean(message));
    clearTimeout(toast.timer);
    if (message) toast.timer = setTimeout(() => { node.textContent = ''; node.classList.remove('show'); }, 3000);
  }
  function tokenStatus(message = '', error = false) {
    const node = byId('admin-token-status');
    node.textContent = message;
    node.style.color = error ? 'var(--admin-red)' : 'var(--admin-green)';
  }
  function stockStatus(message = '', error = false) {
    const node = byId('admin-stock-status');
    node.textContent = message;
    node.style.color = error ? 'var(--admin-red)' : 'var(--admin-green)';
  }

  async function api(path, options = {}) {
    const isRead = !options.method || options.method === 'GET';
    if (isRead && pendingReads.has(path)) return pendingReads.get(path);
    const task = requestApi(path, options);
    if (isRead) pendingReads.set(path, task);
    try { return await task; }
    finally { if (pendingReads.get(path) === task) pendingReads.delete(path); }
  }
  async function requestApi(path, options) {
    const generation = adminGeneration;
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { credentials:'same-origin', ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const isAdminAuthRequired = response.status === 401;
      if (isAdminAuthRequired && path !== '/api/admin/login' && generation === adminGeneration) showLogin();
      throw new Error(
        (payload && payload.error)
          ? payload.error
          : (response.status === 401 ? '后台登录已失效，请重新登录' : `请求失败 (${response.status})`),
      );
    }
    return payload;
  }

  function showLogin() {
    ++adminGeneration;
    ++usersRequestSeq;
    clearTimeout(userSearchTimer);
    pendingReads.clear();
    if (supportBadgeTimer) clearInterval(supportBadgeTimer);
    supportBadgeTimer = null;
    deactivateSupport();
    dashboard = { summary:{}, users:[], tokens:[], recentDeposits:[], recentWithdrawals:[] };
    deposits = [];
    usersOffset = 0; usersTotal = 0;
    supportTickets = []; supportConv = null; supportActiveTicketId = null; supportListSig = '';
    byId('admin-support-ticket-list').replaceChildren();
    byId('admin-support-conv').replaceChildren();
    aMinerData = null; aKlineStatus = null;
    byId('admin-a-miner-root').replaceChildren();
    byId('admin-a-kline-root').replaceChildren();
    byId('admin-users-body').replaceChildren();
    byId('admin-deposits-body').replaceChildren();
    byId('admin-user-detail-modal').hidden = true;
    byId('admin-app').hidden = true;
    byId('admin-login-view').hidden = false;
    byId('admin-password').value = '';
    setTimeout(() => byId('admin-username').focus(), 0);
  }

  async function showApp(session) {
    ++adminGeneration;
    byId('admin-login-view').hidden = true;
    byId('admin-app').hidden = false;
    byId('admin-current-user').textContent = session.username || 'admin';
    // 全局客服未读角标轮询（停留任意页面都能收到新咨询提醒）
    refreshSupportBadge();
    if (supportBadgeTimer) clearInterval(supportBadgeTimer);
    supportBadgeTimer = setInterval(refreshSupportBadge, 15000);
    await navigate('overview');
  }

  function emptyRow(columns, message = '暂无数据') {
    return `<tr><td class="admin-empty" colspan="${columns}">${esc(message)}</td></tr>`;
  }

  function statusBadge(status) {
    return `<span class="admin-status ${statusClass(status)}">${esc(statusText[status] || status || '-')}</span>`;
  }

  function renderOverview() {
    const summary = dashboard.summary || {};
    byId('metric-wallet-users').textContent = Number(summary.walletUsers) || 0;
    byId('metric-real-users').textContent = Number(summary.realUsers) || 0;
    byId('metric-total-deposited').textContent = amount(summary.totalDepositedUsdt);
    byId('metric-total-balance').textContent = amount(summary.totalPlatformBalanceUsdt);
    byId('metric-deposit-count').textContent = `${Number(summary.confirmedDeposits) || 0} 笔到账`;
    byId('todo-pending-deposits').textContent = Number(summary.pendingDeposits) || 0;
    byId('todo-pending-withdrawals').textContent = Number(summary.pendingWithdrawals) || 0;
    byId('todo-enabled-tokens').textContent = (dashboard.tokens || []).filter(item => item.enabled).length;
    byId('overview-deposits-body').innerHTML = (dashboard.recentDeposits || []).map(item => `<tr>
      <td><code title="${esc(item.wallet)}">${esc(shortAddress(item.wallet))}</code></td>
      <td>${esc(String(item.network || '').toUpperCase())}</td>
      <td>${amount(item.amount)} ${esc(item.asset || 'USDT')}</td>
      <td>${statusBadge(item.status)}</td><td>${date(item.createdAt)}</td>
    </tr>`).join('') || emptyRow(5, '暂无充值记录');
  }

  function renderUsers() {
    const items = dashboard.users || [];
    byId('admin-user-count').textContent = `${usersTotal} 位用户`;
    byId('admin-users-page-status').textContent = usersTotal ? `第 ${usersOffset + 1}–${usersOffset + items.length} 位，共 ${usersTotal} 位` : '暂无符合条件的用户';
    byId('admin-users-prev').disabled = usersOffset === 0;
    byId('admin-users-next').disabled = usersOffset + items.length >= usersTotal;
    const levelColor = lv => lv >= 9 ? '#f06b78' : lv >= 7 ? '#f6c454' : lv >= 4 ? '#4fd1b5' : '#82908c';
    const levelPill = lv => `<span style="padding:2px 8px;border-radius:10px;font-size:11px;background:${levelColor(lv)}22;color:${levelColor(lv)};border:1px solid ${levelColor(lv)}55;font-weight:700">A${lv}</span>`;
    const levelOptions = (cur) => Array.from({length:10},(_,i)=>i+1).map(n=>`<option value="${n}" ${Number(cur)===n?'selected':''}>A${n}</option>`).join('');
    byId('admin-users-body').innerHTML = items.map(user => `<tr>
      <td data-label="钱包地址"><code>${esc(user.address)}</code></td>
      <td data-label="等级">${levelPill(user.level || 1)}</td>
      <td data-label="用户类型"><span class="admin-status ${user.isRealUser ? 'good' : ''}">${user.isRealUser ? '真实充值用户' : '钱包用户'}</span></td>
      <td data-label="确认充值">${amount(user.confirmedDepositTotal)} USDT (${Number(user.confirmedDepositCount) || 0} 笔)</td>
      <td data-label="平台余额">${amount(user.platformUsdtBalance)} USDT</td>
      <td data-label="首次连接">${date(user.createdAt)}</td><td data-label="最近充值">${date(user.lastDepositAt)}</td>
      <td data-label="操作" style="white-space:nowrap">
        <button type="button" class="admin-table-action" data-detail-btn="${esc(user.address)}">详情</button>
        <select class="admin-level-select" data-level-wallet="${esc(user.address)}" style="height:30px;padding:0 6px;font-size:11px">${levelOptions(user.level || 1)}</select> <button type="button" class="admin-table-action" data-level-btn="${esc(user.address)}">设置</button>
      </td>
    </tr>`).join('') || emptyRow(8, '没有符合条件的用户');
    document.querySelectorAll('[data-detail-btn]').forEach(btn => btn.addEventListener('click', () => loadUserDetail(btn.dataset.detailBtn)));
    document.querySelectorAll('[data-level-btn]').forEach(btn => btn.addEventListener('click', async () => {
      const wallet = btn.dataset.levelBtn;
      const tr = btn.closest('tr');
      const select = tr && tr.querySelector('select[data-level-wallet]');
      const level = select ? select.value : '1';
      if (!await confirmDialog(`确认将用户 ${shortAddress(wallet)} 的等级设置为 A${level}？`)) return;
      try {
        await api(`/api/admin/users/${encodeURIComponent(wallet)}/level`, { method:'POST', body:JSON.stringify({ level: Number(level) }) });
        toast(`✓ 已设置为 A${level}`);
        await loadAll();
      } catch (error) { toast(error.message); }
    }));
  }

  // ── 用户详情弹窗 ──
  async function loadUserDetail(wallet) {
    const modal = byId('admin-user-detail-modal');
    const body = byId('admin-user-detail-body');
    byId('admin-user-detail-title').textContent = `用户详情 · ${shortAddress(wallet)}`;
    body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--admin-muted)">正在加载...</div>';
    modal.hidden = false;
    try {
      const data = await api(`/api/admin/users/${encodeURIComponent(wallet)}/detail`);
      body.innerHTML = renderUserDetail(data);
      body.querySelector('[data-ats-save]')?.addEventListener('click', () => saveTeamStats(wallet));
      body.querySelector('[data-ats-reset]')?.addEventListener('click', () => resetTeamStats(wallet));
      body.querySelector('[data-awf-freeze]')?.addEventListener('click', () => setWithdrawFreeze(wallet, true));
      body.querySelector('[data-awf-unfreeze]')?.addEventListener('click', () => setWithdrawFreeze(wallet, false));
    } catch (error) {
      body.innerHTML = `<div style="text-align:center;padding:40px;color:var(--admin-red)">加载失败：${esc(error.message)}</div>`;
    }
  }

  // 团队展示数据：保存「页面显示总数」（后端按 设定值-真实值 存差值，仅前端展示）
  async function saveTeamStats(wallet) {
    const read = id => byId(id)?.value ?? '';
    const payload = {
      directCount: read('ats-direct'),
      indirectCount: read('ats-indirect'),
      teamCount: read('ats-team'),
      directMini: read('ats-direct-mini'),
      directPro: read('ats-direct-pro'),
      teamMini: read('ats-team-mini'),
      teamPro: read('ats-team-pro'),
      note: read('ats-note').trim(),
    };
    const labels = { directCount:'直推人数', indirectCount:'间推人数', teamCount:'团队总人数', directMini:'直推 Mini', directPro:'直推 Pro', teamMini:'团队 Mini', teamPro:'团队 Pro' };
    for (const key of Object.keys(labels)) {
      const n = Number(payload[key]);
      if (!Number.isInteger(n) || n < 0) { toast(`${labels[key]}需填写为不小于 0 的整数`); return; }
    }
    if (!await confirmDialog(
      `确认保存 ${shortAddress(wallet)} 的团队展示数据？\n页面将显示：直推 ${payload.directCount} 人、间推 ${payload.indirectCount} 人、团队 ${payload.teamCount} 人；其真实上级的团队数据会自动叠加。\n仅用于页面展示，不影响手续费、等级、分润。`,
    )) return;
    try {
      await api(`/api/admin/users/${encodeURIComponent(wallet)}/team-stats`, { method:'POST', body:JSON.stringify(payload) });
      toast('✓ 团队展示数据已保存');
      await loadUserDetail(wallet);
    } catch (error) { toast(error.message); }
  }

  async function resetTeamStats(wallet) {
    if (!await confirmDialog(`确认恢复 ${shortAddress(wallet)} 的真实团队数据？该地址的全部手动展示设置将被清除。`)) return;
    try {
      await api(`/api/admin/users/${encodeURIComponent(wallet)}/team-stats`, { method:'POST', body:JSON.stringify({ reset:true }) });
      toast('✓ 已恢复真实数据');
      await loadUserDetail(wallet);
    } catch (error) { toast(error.message); }
  }

  // USDT 提现冻结/解冻
  async function setWithdrawFreeze(wallet, frozen) {
    const reason = byId('awf-reason')?.value?.trim() || '';
    const action = frozen ? '冻结' : '解除冻结';
    if (!await confirmDialog(`确认${action} ${shortAddress(wallet)} 的 USDT 提现？`)) return;
    try {
      await api(`/api/admin/users/${encodeURIComponent(wallet)}/withdraw-freeze`, { method:'POST', body:JSON.stringify({ frozen, reason }) });
      toast(frozen ? '✓ 已冻结该账户 USDT 提现' : '✓ 已解除冻结');
      await loadUserDetail(wallet);
    } catch (error) { toast(error.message); }
  }

  function renderUserDetail(d) {
    const KIND_LABELS = {
      miner_direct:'直推·矿机', miner_indirect:'间推·矿机', miner_team:'团队奖·矿机', miner_level_diff:'级差·矿机', miner_parity:'平级·矿机',
      stake_direct:'直推·质押', stake_indirect:'间推·质押', stake_team:'团队奖·质押', stake_level_diff:'级差·质押', stake_parity:'平级·质押',
      parity:'平级奖',
      a10_pool_share:'A10 分红',
    };
    const subHead = (title) => `<h4 class="admin-detail-subhead">${title}</h4>`;
    // 生效人数（含手动展示设置）与真实人数并列
    const effPeople = (eff, real) => {
      const e = Number(eff) || 0;
      const r = Number(real);
      return `${e} 人${Number.isFinite(r) && r !== e ? `（真实 ${r}）` : ''}`;
    };
    // 团队展示数据编辑卡片（仅前端展示）
    const storedOv = d.statsOverride?.stored || null;
    const atsField = (id, label, value, realVal) => `
      <label class="ats-field">
        <span>${label}<small>真实 ${Number(realVal) || 0} 人</small></span>
        <input id="${id}" type="number" min="0" step="1" inputmode="numeric" value="${Number(value) || 0}">
      </label>`;
    const teamStatsEditor = `
      <div class="admin-detail-section ats-editor${storedOv ? ' is-set' : ''}">
        ${subHead(storedOv ? `📊 团队展示数据 · 已手动设置（更新于 ${date(storedOv.updatedAt)}${storedOv.updatedBy ? ` · ${esc(storedOv.updatedBy)}` : ''}）` : '📊 团队展示数据（仅前端展示）')}
        <p class="ats-tip">填写该地址页面要「显示的总人数」，保存后虚拟人数 = 设定值 − 当前真实值；该地址的真实上级打开团队页时，团队人数 / 开通矿机 / 团队业绩（Mini 100 AIX、Pro 1500 AIX）会按真实推荐链自动叠加，页面展示等级也会按虚拟业绩相应提升。仅用于前端展示，不影响手续费率、真实等级与分润等实际权益。</p>
        <div class="ats-grid">
          ${atsField('ats-direct', '直推人数', d.direct?.count, d.statsOverride?.real?.directCount)}
          ${atsField('ats-indirect', '间推人数', d.indirect?.count, d.statsOverride?.real?.indirectCount)}
          ${atsField('ats-team', '团队总人数', d.team?.count, d.statsOverride?.real?.teamCount)}
          ${atsField('ats-direct-mini', '直推开通 Mini（0.002 BNB）', d.direct?.actMini, d.statsOverride?.real?.directMini)}
          ${atsField('ats-direct-pro', '直推开通 Pro（0.05 BNB）', d.direct?.actPro, d.statsOverride?.real?.directPro)}
          ${atsField('ats-team-mini', '团队开通 Mini（0.002 BNB）', d.team?.actMini, d.statsOverride?.real?.teamMini)}
          ${atsField('ats-team-pro', '团队开通 Pro（0.05 BNB）', d.team?.actPro, d.statsOverride?.real?.teamPro)}
          <label class="ats-field ats-note-field">
            <span>备注（可选，仅后台可见）</span>
            <input id="ats-note" type="text" maxlength="200" value="${esc(storedOv?.note || '')}" placeholder="如：市场扶持展示数据">
          </label>
        </div>
        <div class="ats-actions">
          <button type="button" class="admin-primary-button" data-ats-save>保存展示数据</button>
          <button type="button" class="admin-table-action" data-ats-reset>恢复真实数据</button>
        </div>
      </div>`;
    // USDT 提现冻结卡片（账户级风控，仅拦截新的 USDT 提现申请）
    const wfr = d.withdrawFrozen || null;
    const withdrawFreezeCard = `
      <div class="admin-detail-section ats-editor${wfr ? ' is-set' : ''}">
        ${subHead(wfr ? `❄️ USDT 提现 · 已冻结（${date(wfr.frozenAt)}${wfr.frozenBy ? ` · ${esc(wfr.frozenBy)}` : ''}）` : '❄️ USDT 提现冻结（账户级风控）')}
        <p class="ats-tip">冻结后该账户无法发起新的 USDT 提现申请（已提交的提现单不受影响，AIX 提现/互转不受影响）。</p>
        <div class="ats-grid">
          <label class="ats-field ats-note-field">
            <span>冻结原因（可选，冻结时保存）</span>
            <input id="awf-reason" type="text" maxlength="200" value="${esc(wfr?.reason || '')}" placeholder="如：风控审查">
          </label>
        </div>
        <div class="ats-actions">
          ${wfr
            ? '<button type="button" class="admin-table-action" data-awf-unfreeze>解除冻结</button>'
            : '<button type="button" class="admin-primary-button" data-awf-freeze>冻结提现</button>'}
        </div>
      </div>`;
    // 直推列表
    const directRows = (d.direct?.list || []).map(u => `<tr>
      <td><code title="${esc(u.wallet)}">${esc(shortAddress(u.wallet))}</code></td>
      <td>${date(u.joinedAt)}</td>
      <td><span class="admin-status ${u.hasMini ? 'good' : ''}">${u.hasMini ? '✓' : '—'}</span></td>
      <td><span class="admin-status ${u.hasPro ? 'good' : ''}">${u.hasPro ? '✓' : '—'}</span></td>
      <td>${u.minerCount || 0} 台</td>
    </tr>`).join('') || emptyRow(5, '暂无直推用户');
    // 矿机列表
    const minerRows = (d.miners?.items || []).map(m => `<tr>
      <td><code>${esc(String(m.id||'').slice(-8))}</code></td>
      <td>${esc(m.plan || '-')}</td>
      <td><span class="admin-status ${m.status==='active'?'good':''}">${m.status==='active'?'运行中':m.status==='expired'?'已到期':m.status==='redeemed'?'已赎回':m.status}</span></td>
      <td>${amount(m.totalEarnedUnits || 0)} / ${amount(m.totalUnits || 0)} AIX</td>
      <td>${date(m.startedAt)}</td>
    </tr>`).join('') || emptyRow(5, '暂无矿机');
    // 质押列表
    const stakeRows = (d.stakes?.items || []).map(s => `<tr>
      <td><code>${esc(String(s.id||'').slice(-8))}</code></td>
      <td>${esc(s.planId || '-')}</td>
      <td><span class="admin-status ${s.status==='active'?'good':''}">${s.status==='active'?'运行中':s.status}</span></td>
      <td>${amount(s.principalUnits || 0)} AIX</td>
      <td>${amount(s.interestEarnedUnits || 0)} AIX</td>
      <td>${amount(s.principalReturnedUnits || 0)} AIX</td>
      <td>${amount(s.outstandingPrincipalUnits || 0)} AIX</td>
    </tr>`).join('') || emptyRow(7, '暂无质押');
    // 激活记录
    const actRows = (d.activations || []).map(a => `<tr>
      <td><code>${esc(String(a.id||'').slice(-10))}</code></td>
      <td>${a.plan === '1' ? 'Mini (0.002 BNB)' : a.plan === '2' ? 'Pro (0.05 BNB)' : '-'}</td>
      <td><span class="admin-status ${a.status==='confirmed'?'good':a.status==='rejected'?'bad':'warn'}">${a.status==='confirmed'?'已确认':a.status==='rejected'?'已拒绝':'待确认'}</span></td>
      <td>${date(a.createdAt)}</td>
    </tr>`).join('') || emptyRow(4, '暂无激活记录');
    // 订单（inputA/inputUsdt 为剩余冻结量）：挂单中显示「剩余」，已结束显示原始委托量；另列已成交
    const orderRows = (d.orders || []).slice(0, 50).map(o => {
      const isBuy = o.side === 'buy';
      const remain = isBuy ? `${amount(o.inputUsdt || 0)} USDT` : `${amount(o.inputA || 0)} AIX`;
      const total = isBuy
        ? `${amount(Number(o.inputUsdt || 0) + Number(o.filledUsdt || 0))} USDT`
        : `${amount(Number(o.inputA || 0) + Number(o.filledA || 0))} AIX`;
      const filled = isBuy ? `${amount(o.filledUsdt || 0)} USDT` : `${amount(o.filledA || 0)} AIX`;
      const size = o.orderStatus === 'OPEN' ? remain : total;
      return `<tr>
      <td><code>${esc(String(o.orderId||'').slice(-10))}</code></td>
      <td>${esc(isBuy ? '买入' : '卖出')}</td>
      <td><span class="admin-status ${o.orderStatus==='FILLED'?'good':o.orderStatus==='OPEN'?'warn':''}">${o.orderStatus === 'FILLED' ? '已成交' : o.orderStatus === 'OPEN' ? '挂单中' : o.orderStatus === 'CANCELLED' ? '已撤单' : (o.orderStatus || '-')}</span></td>
      <td>${size}</td>
      <td>${filled}</td>
      <td>${amount(o.fillPriceUsdt || o.orderPriceUsdt || 0)} USDT</td>
      <td>${date(o.createdAt)}</td>
    </tr>`;
    }).join('') || emptyRow(7, '暂无交易订单');
    // 互转（transferService 返回 amount / fee / direction 等可读字段）
    const xferRows = (d.transfers || []).slice(0, 50).map(t => `<tr>
      <td><code>${esc(String(t.id||'').slice(-10))}</code></td>
      <td><span class="admin-status ${t.direction==='out'?'warn':'good'}">${t.direction === 'out' ? '转出' : '转入'}</span></td>
      <td>${amount(t.amountA || t.amount || 0)} AIX</td>
      <td>${amount(t.feeA || t.fee || 0)} AIX</td>
      <td>${date(t.createdAt)}</td>
    </tr>`).join('') || emptyRow(5, '暂无互转记录');
    // 团队收益分布
    const byKindRows = Object.entries(d.teamRewards?.byKind || {}).map(([k, v]) => `<tr><td>${esc(KIND_LABELS[k] || k)}</td><td>${amount(v)} AIX</td></tr>`).join('') || emptyRow(2, '暂无团队分润');

    return `
      <div class="admin-detail-section">
        ${subHead('基本信息')}
        <div class="admin-detail-grid">
          <div><span>钱包地址</span><b><code>${esc(d.address)}</code></b></div>
          <div><span>等级${Number(d.displayLevel) > Number(d.level || 0) ? '（真实 / 展示）' : ''}</span><b>A${d.level || 0}${Number(d.displayLevel) > Number(d.level || 0) ? ` <span style="color:#4fd1b5">/ A${d.displayLevel}</span>` : ''}</b></div>
          <div><span>USDT 余额</span><b>${amount(d.usdtBalance)} USDT</b></div>
          <div><span>AIX 余额</span><b>${amount(d.aixBalance)} AIX</b></div>
          <div><span>个人业绩</span><b>${amount(d.personalHeld)} AIX</b></div>
          <div><span>团队业绩</span><b>${amount(d.teamHeld)} AIX</b></div>
          <div><span>推荐人</span><b>${d.referrerWallet ? `<code>${esc(shortAddress(d.referrerWallet))}</code>` : '无'}</b></div>
        </div>
      </div>

      ${teamStatsEditor}

      ${withdrawFreezeCard}

      <div class="admin-detail-section">
        ${subHead(`直推团队（共 ${effPeople(d.direct?.count, d.direct?.realCount)}）`)}
        <div class="admin-detail-stats">
          <span>激活 Mini(0.002)：<b>${effPeople(d.direct?.actMini, d.direct?.realActMini)}</b></span>
          <span>激活 Pro(0.05)：<b>${effPeople(d.direct?.actPro, d.direct?.realActPro)}</b></span>
          <span>待确认：<b>${d.direct?.pending || 0}</b> 笔</span>
          <span>已拒绝：<b>${d.direct?.rejected || 0}</b> 笔</span>
        </div>
        <div class="admin-detail-stats">
          <span>直推总业绩：<b>${amount(d.direct?.holdA || 0)} AIX</b>${Number(d.direct?.virtualHoldA || 0) > 0 ? ` <span style="color:#4fd1b5;font-size:11px">（真实 ${amount(d.direct?.realHoldA || 0)} + 虚拟 ${amount(d.direct?.virtualHoldA || 0)}）</span>` : ''}</span>
        </div>
        <div class="admin-table-scroll"><table><thead><tr><th>直推地址</th><th>加入时间</th><th>Mini</th><th>Pro</th><th>矿机数</th></tr></thead><tbody>${directRows}</tbody></table></div>
      </div>

      <div class="admin-detail-section">
        ${subHead(`间推/团队（间推 ${effPeople(d.indirect?.count, d.indirect?.realCount)} · 团队 ${effPeople(d.team?.count, d.team?.realCount)}）`)}
        <div class="admin-detail-stats">
          <span>团队激活 Mini：<b>${effPeople(d.team?.actMini, d.team?.realActMini)}</b></span>
          <span>团队激活 Pro：<b>${effPeople(d.team?.actPro, d.team?.realActPro)}</b></span>
        </div>
        <div class="admin-detail-stats">
          <span>团队总业绩：<b>${amount(Number(d.teamHeld || 0) + Number(d.team?.virtualHoldA || 0))} AIX</b>${Number(d.team?.virtualHoldA || 0) > 0 ? ` <span style="color:#4fd1b5;font-size:11px">（真实 ${amount(d.teamHeld || 0)} + 虚拟 ${amount(d.team?.virtualHoldA || 0)}）</span>` : ''}</span>
        </div>
      </div>

      <div class="admin-detail-section">
        ${subHead(`矿机（${d.miners?.count || 0} 台 · 累计产出 ${amount(d.miners?.totalReleased || 0)} AIX）`)}
        <div class="admin-table-scroll"><table><thead><tr><th>ID</th><th>套餐</th><th>状态</th><th>已产/总额</th><th>开始时间</th></tr></thead><tbody>${minerRows}</tbody></table></div>
      </div>

      <div class="admin-detail-section">
        ${subHead(`质押（${d.stakes?.count || 0} 笔 · 累计利息 ${amount(d.stakes?.totalEarned || 0)} AIX · 已返本金 ${amount(d.stakes?.principalReturned || 0)} AIX · 累计到账 ${amount(d.stakes?.totalCredited || 0)} AIX）`)}
        <div class="admin-table-scroll"><table><thead><tr><th>ID</th><th>套餐</th><th>状态</th><th>质押 AIX</th><th>累计利息</th><th>已返本金</th><th>质押中本金</th></tr></thead><tbody>${stakeRows}</tbody></table></div>
      </div>

      <div class="admin-detail-section">
        ${subHead('激活记录')}
        <div class="admin-table-scroll"><table><thead><tr><th>ID</th><th>套餐</th><th>状态</th><th>提交时间</th></tr></thead><tbody>${actRows}</tbody></table></div>
      </div>

      <div class="admin-detail-section">
        ${subHead(`AIX 交易订单（近 ${Math.min((d.orders||[]).length, 50)} 条）`)}
        <div class="admin-table-scroll"><table><thead><tr><th>ID</th><th>方向</th><th>状态</th><th>委托量</th><th>已成交</th><th>价格(USDT)</th><th>时间</th></tr></thead><tbody>${orderRows}</tbody></table></div>
      </div>

      <div class="admin-detail-section">
        ${subHead(`AIX 互转记录（近 ${Math.min((d.transfers||[]).length, 50)} 条）`)}
        <div class="admin-table-scroll"><table><thead><tr><th>ID</th><th>方向</th><th>数量</th><th>手续费</th><th>时间</th></tr></thead><tbody>${xferRows}</tbody></table></div>
      </div>

      <div class="admin-detail-section">
        ${subHead(`团队分润收益（${d.teamRewards?.count || 0} 条 · 合计 ${amount(d.teamRewards?.total || 0)} AIX）`)}
        <div class="admin-table-scroll"><table><thead><tr><th>类型</th><th>金额</th></tr></thead><tbody>${byKindRows}</tbody></table></div>
      </div>
    `;
  }

  function renderDeposits() {
    byId('admin-deposit-count').textContent = `${deposits.length} 条记录`;
    byId('admin-deposits-body').innerHTML = deposits.map(item => `<tr>
      <td>${date(item.createdAt)}</td><td><code>${esc(item.wallet)}</code></td>
      <td>${esc(String(item.network || '').toUpperCase())}</td><td>${esc(item.asset || 'USDT')}</td>
      <td>${amount(item.amount)}</td><td>${statusBadge(item.status)}</td>
      <td><code title="${esc(item.txHash || '')}">${esc(shortAddress(item.txHash))}</code></td>
    </tr>`).join('') || emptyRow(7, '暂无充值记录');
  }

  function renderTokens() {
    byId('admin-tokens-body').innerHTML = (dashboard.tokens || []).filter(token => token.category !== 'stock').map(token => `<tr>
      <td><img class="admin-token-logo" src="${esc(token.logo)}" alt=""><b>${esc(token.symbol)}</b></td>
      <td>${esc(token.name)}</td><td>${Number(token.priceDecimals)}</td>
      <td><span class="admin-market-tags">${token.spot ? '<span>现货</span>' : ''}${token.perp ? '<span>合约</span>' : ''}</span></td>
      <td><span class="admin-status ${token.enabled ? 'good' : ''}">${token.enabled ? '已启用' : '已停用'}</span></td>
      <td><button class="admin-table-action" type="button" data-token-toggle="${esc(token.symbol)}" data-enabled="${token.enabled ? '0' : '1'}">${token.enabled ? '停用' : '启用'}</button></td>
    </tr>`).join('') || emptyRow(6, '暂无代币');
    document.querySelectorAll('[data-token-toggle]').forEach(button => {
      button.addEventListener('click', () => toggleToken(button.dataset.tokenToggle, button.dataset.enabled === '1'));
    });
  }

  // 股票字母兜底头像（币安 CDN / 本地图都加载失败时）
  function stockLetterLogo(symbol) {
    const text = String(symbol || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 4);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#38b6a6"/><stop offset="1" stop-color="#2f8fd0"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><text x="32" y="40" font-family="Arial,sans-serif" font-size="${text.length > 2 ? 20 : 26}" font-weight="700" fill="#0b1113" text-anchor="middle">${text}</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function stockLogoCell(token) {
    const sym = esc(token.symbol);
    const local = `/assets/tokens/${sym.toLowerCase()}.png?v=5`;
    const remote = `https://bin.bnbstatic.com/static/stock/${sym}.png`;
    return `<img class="admin-token-logo" src="${local}" alt="" data-stock-logo data-remote="${remote}" data-fallback="${esc(stockLetterLogo(token.symbol))}">`;
  }
  function mergeStocks(stocks) {
    dashboard.tokens = (dashboard.tokens || []).filter(token => token.category !== 'stock').concat(stocks || []);
  }
  function renderStocks() {
    const stocks = (dashboard.tokens || []).filter(token => token.category === 'stock');
    byId('admin-stocks-body').innerHTML = stocks.map(token => `<tr>
      <td>${stockLogoCell(token)}<b>${esc(token.symbol)}</b></td>
      <td>${esc(token.name)}</td><td>${Number(token.priceDecimals)}</td>
      <td><span class="admin-market-tags">${token.spot ? '<span>现货</span>' : ''}${token.perp ? '<span>合约</span>' : ''}</span></td>
      <td><span class="admin-status ${token.enabled ? 'good' : ''}">${token.enabled ? '已启用' : '已停用'}</span></td>
      <td class="admin-stock-actions">
        <button class="admin-table-action" type="button" data-stock-edit="${esc(token.symbol)}">编辑</button>
        <button class="admin-table-action" type="button" data-stock-toggle="${esc(token.symbol)}" data-enabled="${token.enabled ? '0' : '1'}">${token.enabled ? '停用' : '启用'}</button>
        <button class="admin-table-action admin-table-danger" type="button" data-stock-delete="${esc(token.symbol)}">删除</button>
      </td>
    </tr>`).join('') || emptyRow(6, '暂无股票代币');
    byId('admin-stocks-body').querySelectorAll('[data-stock-logo]').forEach(image => {
      image.addEventListener('error', () => {
        if (!image.dataset.triedRemote) { image.dataset.triedRemote = '1'; image.src = image.dataset.remote; }
        else if (!image.dataset.triedFallback) { image.dataset.triedFallback = '1'; image.src = image.dataset.fallback; }
      });
    });
    document.querySelectorAll('[data-stock-toggle]').forEach(button => {
      button.addEventListener('click', () => toggleStock(button.dataset.stockToggle, button.dataset.enabled === '1'));
    });
    document.querySelectorAll('[data-stock-edit]').forEach(button => {
      button.addEventListener('click', () => editStock(button.dataset.stockEdit));
    });
    document.querySelectorAll('[data-stock-delete]').forEach(button => {
      button.addEventListener('click', () => deleteStock(button.dataset.stockDelete));
    });
  }

  async function loadAll() {
    if (byId('admin-app').hidden) return;
    try {
      const generation = adminGeneration, page = currentPage;
      if (page === 'overview') {
        const seq = ++overviewRequestSeq;
        const result = await api('/api/admin/dashboard?view=overview');
        if (generation !== adminGeneration || currentPage !== page || seq !== overviewRequestSeq) return;
        dashboard = { ...dashboard, ...result };
        renderOverview();
      } else if (page === 'users') await loadUsers();
      else if (page === 'deposits') await loadDeposits();
      else if (page === 'tokens' || page === 'stocks') {
        const result = await api('/api/admin/tokens');
        if (generation !== adminGeneration || currentPage !== page) return;
        dashboard.tokens = result.tokens || [];
        if (page === 'tokens') renderTokens(); else renderStocks();
      } else if (page === 'community') await window.AdminCommunity?.load();
      else if (page === 'agents') await window.AdminAgents?.load();
      else if (page === 'lottery') await window.AdminLottery?.load();
      else if (page === 'a-kline') await loadAKline();
      else if (page === 'a-miner') await loadAMiner();
      else if (page === 'support') await loadSupportTickets();
      else if (page === 'announcement') await loadAnnouncement();
      if (generation !== adminGeneration || currentPage !== page) return;
      byId('admin-updated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12:false })}`;
    } catch (error) { toast(error.message); }
  }

  async function loadUsers() {
    const seq = ++usersRequestSeq, generation = adminGeneration;
    const params = new URLSearchParams({ limit:String(USER_PAGE_SIZE), offset:String(usersOffset), q:byId('admin-user-search').value.trim(), realOnly:byId('admin-real-only').checked ? '1' : '0' });
    byId('admin-user-count').textContent = '正在读取用户…';
    byId('admin-users-prev').disabled = byId('admin-users-next').disabled = true;
    const result = await api('/api/admin/users?' + params);
    if (seq !== usersRequestSeq || generation !== adminGeneration || currentPage !== 'users') return;
    usersTotal = Number(result.total) || 0;
    usersOffset = Number(result.offset) || 0;
    if (usersOffset >= usersTotal && usersOffset > 0) {
      usersOffset = Math.max(0, Math.floor((usersTotal - 1) / USER_PAGE_SIZE) * USER_PAGE_SIZE);
      return loadUsers();
    }
    dashboard.users = result.users || [];
    renderUsers();
  }

  async function loadDeposits() {
    const seq = ++depositsRequestSeq, generation = adminGeneration;
    const filter = byId('admin-deposit-filter').value;
    const result = await api(`/api/admin/deposits${filter ? `?status=${encodeURIComponent(filter)}` : ''}`);
    if (generation !== adminGeneration || seq !== depositsRequestSeq || currentPage !== 'deposits') return;
    deposits = result.items || [];
    renderDeposits();
  }

  function navigate(page) {
    if (byId('admin-app').hidden) return;
    ++usersRequestSeq;
    clearTimeout(userSearchTimer);
    currentPage = page;
    const titles = { overview:'首页总览', users:'用户管理', deposits:'充值记录', tokens:'代币管理', stocks:'股票管理', agents:'代理管理', support:'在线客服', community:'社群链接', 'a-kline':'AIX 行情调控', 'a-token-balance':'AIX 代币管理', 'a-miner':'AIX 矿机管理', 'team-activations':'团队激活查询', lottery:'抽奖管理', announcement:'平台公告' };
    document.querySelectorAll('[data-admin-page]').forEach(button => button.classList.toggle('active', button.dataset.adminPage === page));
    document.querySelectorAll('[data-admin-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.adminPanel === page));
    byId('admin-page-title').textContent = titles[page] || '管理后台';
    window.scrollTo({ top:0, behavior:'auto' });
    if (page === 'support') activateSupport(); else deactivateSupport();
    return loadAll();
  }

  async function toggleToken(symbol, enabled) {
    try {
      const result = await api(`/api/admin/tokens/${encodeURIComponent(symbol)}`, { method:'PATCH', body:JSON.stringify({ enabled }) });
      dashboard.tokens = result.tokens || dashboard.tokens;
      renderTokens();
      renderOverview();
      tokenStatus(`${symbol} 已${enabled ? '启用' : '停用'}`);
    } catch (error) { tokenStatus(error.message, true); }
  }

  async function submitToken(event) {
    event.preventDefault();
    const payload = {
      symbol:String(byId('admin-token-symbol').value || '').trim().toUpperCase(),
      name:String(byId('admin-token-name').value || '').trim(),
      priceDecimals:Number(byId('admin-token-decimals').value),
      spot:byId('admin-token-spot').checked,
      perp:byId('admin-token-perp').checked,
      enabled:true,
    };
    try {
      tokenStatus('正在核对币安市场...');
      const result = await api('/api/admin/tokens', { method:'POST', body:JSON.stringify(payload) });
      dashboard.tokens = result.tokens || dashboard.tokens;
      renderTokens();
      event.target.reset();
      byId('admin-token-decimals').value = '4';
      byId('admin-token-spot').checked = true;
      byId('admin-token-perp').checked = true;
      tokenStatus(`${payload.symbol} 已加入平台交易市场`);
    } catch (error) { tokenStatus(error.message, true); }
  }

  // ── 股票代币管理 ──
  async function submitStock(event) {
    event.preventDefault();
    const payload = {
      symbol:String(byId('admin-stock-symbol').value || '').trim().toUpperCase(),
      name:String(byId('admin-stock-name').value || '').trim(),
      priceDecimals:Number(byId('admin-stock-decimals').value),
      spot:byId('admin-stock-spot').checked,
      perp:byId('admin-stock-perp').checked,
      enabled:true,
    };
    try {
      stockStatus('正在核对币安股票市场...');
      const result = await api('/api/admin/stocks', { method:'POST', body:JSON.stringify(payload) });
      mergeStocks(result.stocks);
      renderStocks();
      renderOverview();
      event.target.reset();
      byId('admin-stock-decimals').value = '2';
      byId('admin-stock-spot').checked = true;
      byId('admin-stock-perp').checked = true;
      stockStatus(`${payload.symbol} 已加入平台股票市场`);
    } catch (error) { stockStatus(error.message, true); }
  }

  async function toggleStock(symbol, enabled) {
    try {
      const result = await api(`/api/admin/stocks/${encodeURIComponent(symbol)}`, { method:'PATCH', body:JSON.stringify({ enabled }) });
      mergeStocks(result.stocks);
      renderStocks();
      renderOverview();
      stockStatus(`${symbol} 已${enabled ? '启用' : '停用'}`);
    } catch (error) { stockStatus(error.message, true); }
  }

  async function editStock(symbol) {
    const token = (dashboard.tokens || []).find(item => item.symbol === symbol && item.category === 'stock');
    if (!token) return;
    try {
      const name = await promptDialog(`编辑 ${symbol} 的显示名称：`, token.name);
      if (name === null) return;
      const decimalsInput = await promptDialog(`编辑 ${symbol} 的价格小数位（0-8 整数）：`, String(token.priceDecimals));
      if (decimalsInput === null) return;
      const priceDecimals = Number(decimalsInput.trim());
      if (!Number.isInteger(priceDecimals) || priceDecimals < 0 || priceDecimals > 8) {
        stockStatus('价格小数位必须是 0 到 8 的整数', true);
        return;
      }
      const spot = await confirmDialog(`是否启用 ${symbol} 股票现货市场？${token.spot ? '' : '（当前为关闭，开启前会校验币安市场）'}`, { title:'现货市场' });
      const perp = await confirmDialog(`是否启用 ${symbol} 股票合约市场？${token.perp ? '' : '（当前为关闭，开启前会校验币安市场）'}`, { title:'合约市场' });
      if (!spot && !perp) { stockStatus('现货和合约至少启用一个', true); return; }
      stockStatus('正在保存并校验币安市场...');
      const result = await api(`/api/admin/stocks/${encodeURIComponent(symbol)}`, {
        method:'PATCH',
        body:JSON.stringify({ name:name.trim() || token.name, priceDecimals, spot, perp }),
      });
      mergeStocks(result.stocks);
      renderStocks();
      stockStatus(`${symbol} 修改已保存`);
    } catch (error) { stockStatus(error.message, true); }
  }

  async function deleteStock(symbol) {
    try {
      if (!await confirmDialog(`确认删除股票代币 ${symbol} 吗？删除后前台行情、交易市场将立即移除该股票（内置股票删除后重启也不会恢复）。`, { title:'删除股票', danger:true })) return;
      const result = await api(`/api/admin/stocks/${encodeURIComponent(symbol)}`, { method:'DELETE' });
      mergeStocks(result.stocks);
      renderStocks();
      renderOverview();
      stockStatus(`${symbol} 已删除`);
    } catch (error) { stockStatus(error.message, true); }
  }

  byId('admin-login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = byId('admin-login-button');
    button.disabled = true;
    button.textContent = '登录中...';
    setLoginError();
    try {
      const session = await api('/api/admin/login', { method:'POST', body:JSON.stringify({
        username:byId('admin-username').value.trim(), password:byId('admin-password').value,
      }) });
      await showApp(session);
    } catch (error) { setLoginError(error.message); }
    finally { button.disabled = false; button.textContent = '登录'; }
  });
  byId('admin-logout').addEventListener('click', async () => {
    try { await api('/api/admin/logout', { method:'POST' }); showLogin(); } catch { showLogin(); }
    deactivateSupport();
    if (supportBadgeTimer) { clearInterval(supportBadgeTimer); supportBadgeTimer = null; }
    const badge = byId('admin-support-nav-badge');
    if (badge) badge.hidden = true;
  });
  // 用户详情弹窗关闭
  document.querySelectorAll('[data-close-detail]').forEach(el => el.addEventListener('click', () => {
    byId('admin-user-detail-modal').hidden = true;
  }));
  document.querySelectorAll('[data-open-funds]').forEach(button => button.addEventListener('click', () => window.open('/funds-admin.html', '_blank', 'noopener,noreferrer')));
  byId('admin-refresh').addEventListener('click', loadAll);
  byId('admin-user-search').addEventListener('input', () => {
    ++usersRequestSeq;
    usersOffset = 0;
    clearTimeout(userSearchTimer);
    userSearchTimer = setTimeout(loadAll, 250);
  });
  byId('admin-real-only').addEventListener('change', () => { usersOffset = 0; loadAll(); });
  byId('admin-users-prev').addEventListener('click', () => { usersOffset = Math.max(0, usersOffset - USER_PAGE_SIZE); loadAll(); });
  byId('admin-users-next').addEventListener('click', () => { usersOffset += USER_PAGE_SIZE; loadAll(); });
  byId('admin-deposit-filter').addEventListener('change', () => loadDeposits().catch(error => toast(error.message)));
  byId('admin-token-form').addEventListener('submit', submitToken);
  byId('admin-stock-form').addEventListener('submit', submitStock);

  // 查询用户 AIX 余额
  byId('admin-aix-query-btn')?.addEventListener('click', async () => {
    const wallet = byId('admin-aix-query-wallet').value.trim();
    if (!wallet) { byId('admin-aix-balance-result').textContent = '请输入钱包地址'; return; }
    byId('admin-aix-balance-result').textContent = '查询中...';
    try {
      // 复用用户列表接口，找到对应钱包的 A 余额
      const data = await aApi('/users');
      const user = (data.users || []).find(u => u.address.toLowerCase() === wallet.toLowerCase());
      if (!user) { byId('admin-aix-balance-result').textContent = '该钱包在平台无记录'; return; }
      const aBal = Number(user.A || 0).toLocaleString('en-US', { maximumFractionDigits: 4 });
      const usdtBal = Number(user.USDT || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
      byId('admin-aix-balance-result').innerHTML = `<b>AIX 余额：${aBal}</b>　|　USDT 余额：${usdtBal}`;
    } catch (error) { byId('admin-aix-balance-result').textContent = error.message; }
  });
  // 团队激活查询：整棵下线的 Mini/Pro 激活数，可按直推排除后看净数
  let teamQueryData = null;
  function teamCard(label, value, sub, color) {
    return `<div style="flex:1;min-width:120px;border:1px solid var(--border);border-radius:10px;padding:10px 12px;background:var(--panel)">
      <div style="font-size:12px;color:var(--mut)">${label}</div>
      <div style="font-size:22px;font-weight:700;color:${color}">${value}</div>
      <div style="font-size:11px;color:var(--mut)">${sub}</div></div>`;
  }
  function teamCheckedSet() {
    return new Set([...document.querySelectorAll('#admin-team-direct-body input[type=checkbox]:checked')].map(c => c.dataset.wallet));
  }
  function renderTeamResult() {
    const box = byId('admin-team-result');
    const detail = byId('admin-team-detail');
    if (!box || !teamQueryData) return;
    const d = teamQueryData;
    const checked = teamCheckedSet();
    const picked = d.directRows.filter(r => checked.has(r.wallet));
    const exMini = picked.reduce((s, r) => s + r.mini, 0);
    const exPro = picked.reduce((s, r) => s + r.pro, 0);
    const exMembers = picked.reduce((s, r) => s + r.members, 0);
    const hasEx = checked.size > 0;
    const netMini = d.teamMini - exMini, netPro = d.teamPro - exPro, netCount = d.teamCount - exMembers;
    const pair = (net, all) => hasEx ? `${net}<span style="font-size:13px;font-weight:400;color:var(--mut)"> / ${all}</span>` : String(all);
    box.innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px">
      ${teamCard('团队总人数', hasEx ? `${netCount}<span style="font-size:13px;font-weight:400;color:var(--mut)"> / ${d.teamCount}</span>` : d.teamCount, `直推 ${d.directCount} · 间推 ${d.indirectCount}`, 'var(--txt)')}
      ${teamCard('Mini 激活（团队）', pair(netMini, d.teamMini), hasEx ? `已排除 ${exMini}` : '全部直推', 'var(--brand)')}
      ${teamCard('Pro 激活（团队）', pair(netPro, d.teamPro), hasEx ? `已排除 ${exPro}` : '全部直推', 'var(--blu)')}
    </div>
    <div style="margin-top:8px;font-size:12px;color:var(--mut)">地址：<span style="font-family:monospace">${esc(d.address)}</span>${
      hasEx ? `　|　已排除 ${checked.size} 个直推（${exMembers} 人）` : ''}</div>`;
    if (detail) detail.hidden = !d.directRows.length;
    const countEl = byId('admin-team-direct-count');
    if (countEl) countEl.textContent = `${d.directCount} 个直推（每人含其整棵子树）`;
    const body = byId('admin-team-direct-body');
    if (!body) return;
    body.innerHTML = d.directRows.length
      ? d.directRows.map(r => `<tr>
        <td><input type="checkbox" data-wallet="${esc(r.wallet)}"${checked.has(r.wallet) ? ' checked' : ''}></td>
        <td style="font-family:monospace">${esc(r.wallet)}</td>
        <td>${r.members}</td><td>${r.mini}</td><td>${r.pro}</td></tr>`).join('')
      : '<tr><td colspan="5" style="color:var(--mut)">该地址没有任何直推</td></tr>';
    body.querySelectorAll('input[type=checkbox]').forEach(c => c.addEventListener('change', renderTeamResult));
  }
  byId('admin-team-query-btn')?.addEventListener('click', async () => {
    const wallet = byId('admin-team-wallet').value.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) { byId('admin-team-result').textContent = '请输入正确的钱包地址（0x 开头 42 位）'; teamQueryData = null; byId('admin-team-detail').hidden = true; return; }
    byId('admin-team-result').textContent = '查询中...';
    byId('admin-team-detail').hidden = true;
    try {
      teamQueryData = await aApi('/team-activations?address=' + encodeURIComponent(wallet.toLowerCase()));
      renderTeamResult();
    } catch (error) { teamQueryData = null; byId('admin-team-result').textContent = error.message; }
  });
  byId('admin-team-wallet')?.addEventListener('keydown', event => { if (event.key === 'Enter') byId('admin-team-query-btn')?.click(); });
  byId('admin-team-clear-exclude')?.addEventListener('click', () => {
    document.querySelectorAll('#admin-team-direct-body input[type=checkbox]').forEach(c => { c.checked = false; });
    renderTeamResult();
  });
  // ── 平台公告：读取当前内容 / 保存（最多 2 条，中英双语，存 service_settings）──
  async function loadAnnouncement() {
    const status = byId('admin-announce-status');
    try {
      const data = await api('/api/announcement');
      const items = Array.isArray(data.items) ? data.items : [];
      let latest = 0;
      for (const i of [0, 1]) {
        const item = items[i] || {};
        byId(`admin-announce-enabled-${i + 1}`).checked = item.enabled !== false && !!String(item.zh || item.en || '');
        byId(`admin-announce-zh-${i + 1}`).value = item.zh || '';
        byId(`admin-announce-en-${i + 1}`).value = item.en || '';
        latest = Math.max(latest, Number(item.updatedAt) || 0);
      }
      if (status) status.textContent = latest
        ? `上次更新 ${new Date(latest).toLocaleString('zh-CN', { hour12:false })}`
        : '尚未设置公告';
    } catch (error) { if (status) status.textContent = error.message; }
  }
  byId('admin-announce-save')?.addEventListener('click', async () => {
    const status = byId('admin-announce-status');
    const items = [1, 2].map(n => ({
      id: `a${n}`,
      enabled: byId(`admin-announce-enabled-${n}`).checked,
      zh: byId(`admin-announce-zh-${n}`).value.trim(),
      en: byId(`admin-announce-en-${n}`).value.trim(),
    }));
    if (status) status.textContent = '保存中...';
    try {
      await aApi('/announcement', { method:'POST', body: JSON.stringify({ items }) });
      if (status) status.textContent = `已保存 ${new Date().toLocaleTimeString('zh-CN', { hour12:false })}`;
    } catch (error) { if (status) status.textContent = error.message; }
  });
  document.querySelectorAll('[data-admin-page]').forEach(button => button.addEventListener('click', () => {
    navigate(button.dataset.adminPage);
    // mobile: 点菜单后自动收起侧栏
    try { document.body.classList.remove('admin-nav-open'); } catch (_) {}
  }));
  document.querySelectorAll('[data-jump-page]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.jumpPage)));

  // ── 移动端侧边栏抽屉开关 ──
  const body = document.body;
  const menuBtn = byId('admin-menu-toggle');
  const backdrop = byId('admin-sidebar-backdrop');
  function setNav(open) {
    body.classList.toggle('admin-nav-open', !!open);
    if (menuBtn) {
      menuBtn.setAttribute('aria-expanded', String(!!open));
      menuBtn.textContent = open ? '✕' : '☰';
    }
  }
  menuBtn?.addEventListener('click', () => setNav(!body.classList.contains('admin-nav-open')));
  backdrop?.addEventListener('click', () => setNav(false));
  window.addEventListener('resize', () => {
    if (window.innerWidth > 700) setNav(false);
  });

  /* ============================================================
   * 在线客服后台模块
   * ============================================================ */
  let supportTickets = [];
  let supportActiveTicketId = null;
  let supportConv = null;
  let supportListTimer = null;
  let supportConvTimer = null;
  let supportBadgeTimer = null;
  let supportEventsBound = false;

  function supportShortWallet(w) {
    const s = String(w || '');
    return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : (s || '-');
  }
  function supportTime(ts) {
    return new Date(Number(ts) || Date.now()).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });
  }

  let supportListSig = '';
  async function loadSupportTickets() {
    const generation = adminGeneration;
    const filterEl = byId('admin-support-filter');
    const status = filterEl ? filterEl.value : 'open';
    const data = await api(`/api/admin/support/tickets?status=${encodeURIComponent(status)}&limit=200`);
    if (generation !== adminGeneration || currentPage !== 'support' || status !== filterEl?.value) return;
    supportTickets = data.tickets || [];
    // 列表无变化时跳过重绘，避免 5s 轮询冲掉正要点击的会话项
    const sig = status + '|' + supportTickets.map(t => `${t.id}:${t.status}:${t.adminUnread}:${t.lastMessageAt}:${String(t.lastBody || '').slice(0, 30)}`).join(',');
    if (sig === supportListSig) return;
    supportListSig = sig;
    renderSupportTickets();
  }

  function renderSupportTickets() {
    const host = byId('admin-support-ticket-list');
    if (!host) return;
    if (!supportTickets.length) {
      host.innerHTML = '<div class="admin-inline-status" style="padding:24px 12px;text-align:center">暂无会话</div>';
      return;
    }
    host.innerHTML = supportTickets.map(t => {
      const active = t.id === supportActiveTicketId;
      const unread = Number(t.adminUnread || 0);
      const closed = t.status === 'closed';
      const preview = String(t.lastBody || '').replace(/\s+/g, ' ').slice(0, 60);
      return `<button type="button" class="admin-support-ticket${active ? ' active' : ''}" data-support-ticket="${esc(t.id)}">
        <div class="admin-support-ticket-row">
          <code>${esc(supportShortWallet(t.wallet))}</code>
          ${unread > 0 ? `<span class="admin-support-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
          ${closed ? '<span class="admin-support-closed">已关闭</span>' : ''}
        </div>
        <div class="admin-support-preview">${esc(preview || '（无消息）')}</div>
        <div class="admin-support-time">${supportTime(t.lastMessageAt)}</div>
      </button>`;
    }).join('');
    host.querySelectorAll('[data-support-ticket]').forEach(btn => {
      btn.addEventListener('click', () => openSupportTicket(btn.dataset.supportTicket));
    });
  }

  async function openSupportTicket(id) {
    const generation = adminGeneration;
    supportActiveTicketId = id;
    renderSupportTickets();
    const data = await api(`/api/admin/support/tickets/${encodeURIComponent(id)}/messages`);
    if (generation !== adminGeneration || currentPage !== 'support' || supportActiveTicketId !== id) return;
    supportConv = data;
    renderSupportConversation();
    refreshSupportBadge();
  }

  function renderSupportConversation() {
    const host = byId('admin-support-conv');
    if (!host) return;
    if (!supportConv) {
      host.innerHTML = '<div class="admin-support-conv-empty">从左侧选择一个会话查看并回复</div>';
      return;
    }
    const t = supportConv.ticket || {};
    const msgs = supportConv.messages || [];
    const closed = t.status === 'closed';
    host.innerHTML = `
      <div class="as-head">
        <div>
          <strong title="${esc(t.wallet || '')}">${esc(t.wallet || '-')}</strong>
          <small>${closed ? '会话已关闭 · 回复将自动重新开启' : '会话进行中'} · ${msgs.length} 条消息</small>
        </div>
        <button type="button" class="admin-secondary-button" id="admin-support-close" ${closed ? 'disabled' : ''}>${closed ? '已关闭' : '关闭会话'}</button>
      </div>
      <div class="as-messages" id="admin-support-messages"></div>
      <div class="as-reply">
        <textarea id="admin-support-reply-input" rows="2" maxlength="2000" placeholder="输入回复内容…（Enter 发送，Shift+Enter 换行）"></textarea>
        <button type="button" class="admin-primary-button" id="admin-support-send">发送回复</button>
      </div>`;
    const box = byId('admin-support-messages');
    if (box) {
      for (const message of msgs) {
        const row = document.createElement('div'); row.className = `as-msg ${message.sender === 'admin' ? 'me' : 'them'}`;
        const bubble = document.createElement('div'); bubble.className = 'as-bubble'; bubble.style.whiteSpace = 'pre-wrap'; bubble.textContent = String(message.body ?? '');
        const time = document.createElement('div'); time.className = 'as-time'; time.textContent = `${message.sender === 'admin' ? '客服' : '用户'} · ${supportTime(message.createdAt)}`;
        row.append(bubble, time); box.append(row);
      }
      if (!msgs.length) { const empty = document.createElement('div'); empty.className = 'as-empty'; empty.textContent = '还没有消息'; box.append(empty); }
      box.scrollTop = box.scrollHeight;
    }
    byId('admin-support-send').addEventListener('click', sendSupportReply);
    byId('admin-support-close').addEventListener('click', closeSupportTicketFromAdmin);
    const input = byId('admin-support-reply-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendSupportReply(); }
    });
    setTimeout(() => input.focus(), 30);
  }

  async function sendSupportReply() {
    if (!supportActiveTicketId) return;
    const input = byId('admin-support-reply-input');
    const body = String(input?.value || '').trim();
    if (!body) return;
    const btn = byId('admin-support-send');
    btn.disabled = true;
    try {
      const data = await api(`/api/admin/support/tickets/${encodeURIComponent(supportActiveTicketId)}/reply`, {
        method:'POST', body:JSON.stringify({ body }),
      });
      supportConv = data;
      input.value = '';
      renderSupportConversation();
      await loadSupportTickets();
    } catch (error) {
      toast(error.message);
      btn.disabled = false;
    }
  }

  async function closeSupportTicketFromAdmin() {
    if (!supportActiveTicketId) return;
    if (!await confirmDialog('确认关闭该用户会话吗？用户再次发消息会自动重新开启。')) return;
    try {
      await api(`/api/admin/support/tickets/${encodeURIComponent(supportActiveTicketId)}/close`, { method:'POST' });
      toast('会话已关闭');
      await openSupportTicket(supportActiveTicketId);
      await loadSupportTickets();
    } catch (error) { toast(error.message); }
  }

  async function refreshSupportConvSilent() {
    if (!supportActiveTicketId) return;
    const generation = adminGeneration, id = supportActiveTicketId;
    try {
      const data = await api(`/api/admin/support/tickets/${encodeURIComponent(id)}/messages`);
      if (generation !== adminGeneration || currentPage !== 'support' || supportActiveTicketId !== id) return;
      const prevLen = supportConv?.messages?.length || 0;
      supportConv = data;
      // 仅在消息数变化时重绘，避免输入过程中 DOM 被重置
      if ((data.messages?.length || 0) !== prevLen) renderSupportConversation();
    } catch { /* 静默保留旧画面 */ }
  }

  async function refreshSupportBadge() {
    if (byId('admin-app').hidden || document.hidden) return;
    const generation = adminGeneration;
    try {
      const data = await api('/api/admin/support/unread-count');
      if (generation !== adminGeneration) return;
      const n = Number(data.count || 0);
      const badge = byId('admin-support-nav-badge');
      if (badge) {
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.hidden = n <= 0;
      }
    } catch { /* 静默 */ }
  }

  function bindSupportEvents() {
    if (supportEventsBound) return;
    supportEventsBound = true;
    byId('admin-support-refresh')?.addEventListener('click', async () => {
      try { await Promise.all([loadSupportTickets(), supportActiveTicketId ? openSupportTicket(supportActiveTicketId) : null]); }
      catch (error) { toast(error.message); }
    });
    byId('admin-support-filter')?.addEventListener('change', () => {
      supportActiveTicketId = null;
      supportConv = null;
      renderSupportConversation();
      loadSupportTickets().catch(error => toast(error.message));
    });
  }

  function activateSupport() {
    bindSupportEvents();
    refreshSupportBadge();
    if (supportListTimer) clearInterval(supportListTimer);
    if (supportConvTimer) clearInterval(supportConvTimer);
    supportListTimer = setInterval(() => { if (!document.hidden) { loadSupportTickets().catch(() => {}); refreshSupportBadge(); } }, 5000);
    supportConvTimer = setInterval(() => { if (!document.hidden) refreshSupportConvSilent(); }, 5000);
  }
  function deactivateSupport() {
    if (supportListTimer) { clearInterval(supportListTimer); supportListTimer = null; }
    if (supportConvTimer) { clearInterval(supportConvTimer); supportConvTimer = null; }
  }

  /* ============================================================
   * AIX 行情 / 矿机管理 后台模块（嵌入 admin 后台，走 cookie 鉴权）
   * ============================================================ */
  const PERIOD_LABELS = { '1m':'1 分', '5m':'5 分', '15m':'15 分', '1h':'1 时', '4h':'4 时', '1d':'日线' };
  let aKlineStatus = null;
  let aMinerData = null;

  async function aApi(path, options = {}) {
    const url = path.startsWith('/') ? `/api/admin/a-token${path}` : `/api/admin/a-token/${path}`;
    return api(url, options);
  }
  function aFmt(v, d = 2) { return Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: Math.min(2, d) }); }
  function aPill(color, text) { return `<span style="padding:2px 8px;border-radius:10px;font-size:11px;background:${color}22;color:${color};border:1px solid ${color}55">${esc(text)}</span>`; }
  function aBtn(text, { id='', cls='', data='' } = {}) { return `<button type="button" class="admin-primary-button admin-a-btn ${cls}" ${id ? `id="${id}"` : ''} ${data}>${text}</button>`; }

  async function loadAKline() {
    const generation = adminGeneration, seq = ++klineRequestSeq;
    try {
      const result = await aApi('/kline/status');
      if (generation !== adminGeneration || seq !== klineRequestSeq || currentPage !== 'a-kline') return;
      aKlineStatus = result; renderAKline();
    } catch (e) { const root = byId('admin-a-kline-root'); if (root && generation === adminGeneration && seq === klineRequestSeq && currentPage === 'a-kline') root.innerHTML = `<div class="admin-inline-status" style="color:var(--admin-red)">加载失败：${esc(e.message)}</div>`; }
  }
  function renderAKline() {
    const root = byId('admin-a-kline-root'); if (!root) return;
    const s = aKlineStatus && aKlineStatus.status ? aKlineStatus.status : (aKlineStatus || {});
    const pool = aKlineStatus?.pool || {};
    const settings = s.settings || {};
    const periods = s.periods || {};
    const mode = settings.mode || 'manual';
    // 五种模式：白话标签 + 一句话说明，点一下立即生效
    const modes = [['daily','🎯 每天涨跌固定','#f6c454'],['sideways','〰 基本走平','#50d2c2'],['up','📈 慢慢涨','#50d2a8'],['down','📉 慢慢跌','#f26c78'],['manual','⏸ 价格固定不动','#81918e']];
    const modeDesc = {
      daily: '每天按下方“每天涨跌多少 %”匀速走完，第二天北京时间 00:00 自动重新开始。',
      sideways: '价格小幅波动，总体基本走平。',
      up: '价格缓慢上涨（约每分钟 +0.08%），K 线自动生成。',
      down: '价格缓慢下跌（约每分钟 -0.08%），K 线自动生成。',
      manual: '价格完全固定不动，K 线停止推进。点“重置开盘”后会自动切到这个模式。',
    };
    const tip = (html) => `<div style="font-size:12px;color:#81918e;margin:6px 0 10px">${html}</div>`;
    const stat = (label, value, color) => `<div class="admin-a-stat"><small>${esc(label)}</small><b style="color:${color}">${esc(value)}</b></div>`;
    const pct = Number(settings.dailyChangePct ?? 1);
    const dp = s.dailyProgress || null;
    const dailyLine = dp ? (dp.fixed
      ? tip(`🎯 阶梯恒定价：今日全天恒定 <b style="color:#50d2c2">$${Number(dp.targetEodPrice).toFixed(4)}</b>（锚定 $${Number(dp.startPrice).toFixed(4)} ${pct >= 0 ? '+' : ''}${pct}%），每天北京时间 00:00 跳到下一档价位`)
      : tip(`🎯 今日行程：起点 $${Number(dp.startPrice).toFixed(4)} → 目标 <b style="color:#50d2c2">$${Number(dp.targetEodPrice).toFixed(4)}</b>（${pct >= 0 ? '+' : ''}${pct}%），已推进 <b style="color:#f6c454">${Number(dp.progressPct).toFixed(1)}%</b>，每天北京时间 00:00 自动换日重新起算`)) : '';
    root.innerHTML = `
      <div class="admin-a-grid">
        ${stat('当前价 (USDT)', aFmt(pool.priceUsdt, 4), '#50d2c2')}
        ${stat('今日成交量 (AIX)', aFmt(pool.todayVolumeA, 0), '#8a7dff')}
        ${stat('今日成交额 (U)', aFmt(pool.todayVolumeUsdt, 2), '#f6c454')}
        ${stat('分红池 (AIX)', aFmt(pool.dividendPool, 0), '#50d2a8')}
      </div>
      <div class="admin-a-card">
        <h3>📈 行情模式（点一下立即生效）</h3>
        <div class="admin-a-row-btns">${modes.map(([k,l,c]) => `<button type="button" class="admin-a-mode ${mode===k?'active':''}" data-mode="${k}" style="${mode===k?`background:${c}22;color:${c};border:1px solid ${c}55`:''}">${l}</button>`).join('')}</div>
        ${tip(esc(modeDesc[mode] || ''))}
        ${dailyLine}
        <div class="admin-a-form-grid">
          <label>🎯 每天涨跌多少 %（正数=涨，负数=跌）<input id="a-daily-pct" type="number" min="-95" max="95" step="0.1" value="${pct}"></label>
          <label>📊 K 线波动大小（1=正常，0.2=很平，3=剧烈）<input id="a-vol" type="number" min="0.1" max="5" step="0.1" value="${Number(settings.volatility ?? 1)}"></label>
          <label style="align-self:flex-end">${aBtn('💾 保存设置', { id:'a-save-mode' })}</label>
        </div>
      </div>
      <div class="admin-a-card">
        <h3>🆕 重置 K 线（像刚开盘一样重新开始）</h3>
        ${tip('清空全部历史 K 线，从下面的开盘价重新生成一段“刚开盘”的行情，并把价格固定在开盘价不动。之后想让它自动走，到上面选一个模式即可。')}
        <div class="admin-a-form-grid">
          <label>开盘价 (USDT)<input id="a-reset-price" type="number" min="0.0001" step="any" value="0.1"></label>
          <label style="align-self:flex-end">${aBtn('🆕 重置开盘并固定价格', { id:'a-reset-open' })}</label>
        </div>
      </div>
      <div class="admin-a-card">
        <h3>🔥 每日固定销毁补足</h3>
        ${tip('只控制「每日固定补足销毁」：开启后，当天各类销毁累计不足 100 万枚时，跨日结算自动补足到 100 万枚；关闭则暂停补足。交易/互转手续费固定「50% 销毁 + 50% 进 A10 池」，VIP 开通/续费销毁 100 枚，均不受此开关影响。')}
        <div class="admin-a-form-grid">
          <label>当前状态：${pool.burnEnabled ? '<b style="color:#50d2c2">✅ 每日补足销毁已开启（不足100万枚自动补足）</b>' : '<b style="color:#f6c454">⏸ 每日补足销毁已暂停（不做补足）</b>'}</label>
          <label style="align-self:flex-end">${aBtn(pool.burnEnabled ? '⏸ 暂停补足' : '🔥 开启补足', { id:'a-burn-toggle' })}</label>
        </div>
      </div>
      <div class="admin-a-card">
        <h3>⛏ 矿机激活开关</h3>
        ${tip('关闭时：用户无法激活（购买）矿机，提交时提示「矿机激活暂未开放」。已运行的矿机产出不受影响。')}
        <div class="admin-a-form-grid">
          <label>当前状态：${pool.activationEnabled ? '<b style="color:#50d2c2">✅ 激活已开放（用户可购买矿机）</b>' : '<b style="color:#f6c454">⛔ 激活已关闭（用户不可购买矿机）</b>'}</label>
          <label style="align-self:flex-end">${aBtn(pool.activationEnabled ? '⛔ 关闭激活' : '⛏ 开放激活', { id:'a-activation-toggle' })}</label>
        </div>
      </div>
      <div class="admin-a-card">
        <h3>💸 AIX 提现开关</h3>
        ${tip('关闭时：用户无法发起 AIX 链上提现，提交时提示「AIX 提现暂未开放」。已提交的提现单照常处理。')}
        <div class="admin-a-form-grid">
          <label>当前状态：${pool.withdrawEnabled ? '<b style="color:#50d2c2">✅ 提现已开放</b>' : '<b style="color:#f6c454">⛔ 提现已关闭</b>'}</label>
          <label style="align-self:flex-end">${aBtn(pool.withdrawEnabled ? '⛔ 关闭提现' : '💸 开放提现', { id:'a-withdraw-toggle' })}</label>
        </div>
      </div>
      <div class="admin-a-card">
        <h3>📚 K 线数据（各周期已有多少根）</h3>
        <div class="admin-a-grid">${Object.keys(PERIOD_LABELS).map(p => stat(PERIOD_LABELS[p], `${periods[p]?.count ?? 0} 根`, '#50d2c2')).join('')}</div>
      </div>
      <details class="admin-a-card">
        <h3 style="cursor:pointer">🧰 高级操作（平时不用管）</h3>
        <div class="admin-a-form-grid">
          <label>⏩ 手动快进：一步 ≈ 20 秒行情（“价格固定不动”模式下无效）<input id="a-tick-n" type="number" min="1" max="120" step="1" value="6"></label>
          <label style="align-self:flex-end">${aBtn('⏩ 快进 N 步', { id:'a-tick-go' })}</label>
        </div>
        <div class="admin-a-form-grid" style="grid-template-columns: 1.2fr repeat(5,1fr) auto;margin-top:10px">
          <label>✍️ 手写一根 K 线：周期<select id="a-c-period">${Object.keys(PERIOD_LABELS).map(p=>`<option value="${p}">${PERIOD_LABELS[p]}</option>`).join('')}</select></label>
          <label>开<input id="a-c-open" type="number" step="any" value="${Number(pool.priceUsdt || 0)}"></label>
          <label>高<input id="a-c-high" type="number" step="any" value="${(Number(pool.priceUsdt || 0) * 1.01).toFixed(4)}"></label>
          <label>低<input id="a-c-low" type="number" step="any" value="${(Number(pool.priceUsdt || 0) * 0.99).toFixed(4)}"></label>
          <label>收<input id="a-c-close" type="number" step="any" value="${Number(pool.priceUsdt || 0)}"></label>
          <label>量<input id="a-c-vol" type="number" min="0" step="any" value="0"></label>
          <label style="align-self:flex-end">${aBtn('✍️ 写入', { id:'a-c-write' })}</label>
        </div>
      </details>
    `;
    // 绑定 kline 事件
    root.querySelectorAll('.admin-a-mode').forEach(b=>{b.addEventListener('click',async()=>{try{await aApi('/kline/mode',{method:'POST',body:JSON.stringify({mode:b.dataset.mode})});toast('已切换 '+b.textContent);await loadAKline();}catch(e){toast(e.message);}});});
    const $id = (id)=>document.getElementById(id);
    const aSetBtn = (id, label, ok=true) => { const el=$id(id); if(!el)return; const t=el.textContent; el.disabled=true; el.textContent=label; setTimeout(()=>{el.textContent=t; el.disabled=false;}, 1500); if(ok)toast(label); };
    $id('a-save-mode')?.addEventListener('click', async ()=>{ try{await aApi('/kline/mode',{method:'POST',body:JSON.stringify({dailyChangePct: Number($id('a-daily-pct').value ?? 1), volatility: Number($id('a-vol').value || 1)})}); aSetBtn('a-save-mode','✓ 已保存'); await loadAKline(); }catch(e){toast(e.message);}});
    $id('a-reset-open')?.addEventListener('click', async ()=>{ try{const p=Number($id('a-reset-price').value); if(!(p>0)){toast('请输入正确的开盘价');return;} if(!await confirmDialog(`⚠ 将清空全部历史 K 线，从 $${p} 重新开始，并把价格固定在 $${p}（模式切为“价格固定不动”）。确定？`))return; await aApi('/kline/rebuild',{method:'POST',body:JSON.stringify({basePrice:p})}); await aApi('/kline/mode',{method:'POST',body:JSON.stringify({mode:'manual'})}); aSetBtn('a-reset-open',`✓ 已重置到 $${p} 并固定`); await loadAKline(); }catch(e){toast(e.message);}});
    $id('a-tick-go')?.addEventListener('click', async ()=>{ try{const n=Math.max(1,Math.min(120,Number($id('a-tick-n').value||1)));await aApi('/kline/tick',{method:'POST',body:JSON.stringify({n})});aSetBtn('a-tick-go',`✓ 快进 ${n} 步`);await loadAKline();}catch(e){toast(e.message);}});
    $id('a-c-write')?.addEventListener('click', async ()=>{ try{const candle={open:Number($id('a-c-open').value),high:Number($id('a-c-high').value),low:Number($id('a-c-low').value),close:Number($id('a-c-close').value),volume:Number($id('a-c-vol').value)}; await aApi('/kline/append',{method:'POST',body:JSON.stringify({period:$id('a-c-period').value, candle})}); aSetBtn('a-c-write','✓ 已写入');await loadAKline();}catch(e){toast(e.message);}});
    $id('a-burn-toggle')?.addEventListener('click', async ()=>{
      const turningOn = !pool.burnEnabled;
      const msg = turningOn
        ? '⚠ 确定开启每日补足销毁？开启后：当天各类销毁累计不足 100 万枚时，跨日自动补足到 100 万枚。'
        : '确定暂停每日补足销毁？暂停后不再自动补足。交易/互转手续费仍固定 50% 销毁 + 50% 进 A10 池，不受影响。';
      if (!await confirmDialog(msg)) return;
      try { await aApi('/burn/mode', { method:'POST', body:JSON.stringify({ enabled: turningOn }) }); aSetBtn('a-burn-toggle', turningOn?'✓ 已开启销毁':'✓ 已暂停销毁'); await loadAKline(); }
      catch(e){ toast(e.message); }
    });
    $id('a-activation-toggle')?.addEventListener('click', async ()=>{
      const turningOn = !pool.activationEnabled;
      const msg = turningOn
        ? '确定开放矿机激活？开放后用户可正常激活（购买）矿机。'
        : '⚠ 确定关闭矿机激活？关闭后用户将无法激活（购买）矿机，已运行矿机不受影响。';
      if (!await confirmDialog(msg)) return;
      try { await aApi('/activation/mode', { method:'POST', body:JSON.stringify({ enabled: turningOn }) }); aSetBtn('a-activation-toggle', turningOn?'✓ 已开放激活':'✓ 已关闭激活'); await loadAKline(); }
      catch(e){ toast(e.message); }
    });
    $id('a-withdraw-toggle')?.addEventListener('click', async ()=>{
      const turningOn = !pool.withdrawEnabled;
      const msg = turningOn
        ? '确定开放 AIX 提现？开放后用户可正常发起 AIX 链上提现。'
        : '⚠ 确定关闭 AIX 提现？关闭后用户将无法发起新的 AIX 提现，已提交的提现单照常处理。';
      if (!await confirmDialog(msg)) return;
      try { await aApi('/withdraw/mode', { method:'POST', body:JSON.stringify({ enabled: turningOn }) }); aSetBtn('a-withdraw-toggle', turningOn?'✓ 已开放提现':'✓ 已关闭提现'); await loadAKline(); }
      catch(e){ toast(e.message); }
    });
  }

  async function loadAMiner(qs = '') {
    const generation = adminGeneration, seq = ++minerRequestSeq;
    try {
      const result = await aApi('/miners' + (qs ? '?'+qs : ''));
      if (generation !== adminGeneration || seq !== minerRequestSeq || currentPage !== 'a-miner') return;
      aMinerData = result; renderAMiner();
    } catch (e) { const root = byId('admin-a-miner-root'); if (root && generation === adminGeneration && seq === minerRequestSeq && currentPage === 'a-miner') root.innerHTML = `<div class="admin-inline-status" style="color:var(--admin-red)">加载失败：${esc(e.message)}</div>`; }
  }
  function renderAMiner() {
    const root = byId('admin-a-miner-root'); if (!root) return;
    const m = aMinerData || {}; const items = m.items || []; const summary = m.summary?.by || {};
    const total = m.summary?.total || 0;
    const aActive = (summary['active:mini120'] || 0) + (summary['active:pro1500'] || 0);
    const aDone = (summary['completed:mini120'] || 0) + (summary['completed:pro1500'] || 0);
    const plans = m.plans || [];
    const actMeta = m.activationMeta || {};
    const progCap = Math.max(1, Math.floor(Number(actMeta.cap)) || 1000000);
    const progCount = Math.max(0, Math.floor(Number(actMeta.activatedCount)) || 0);
    const progReal = Math.max(0, Math.floor(Number(actMeta.activatedCountReal)) || 0);
    const progPct = Math.min(100, progCount / progCap * 100).toFixed(2);
    const stat = (label, value, color) => `<div class="admin-a-stat"><small>${esc(label)}</small><b style="color:${color}">${esc(value)}</b></div>`;
    const planDaily = (p) => { const row = plans.find(x=>x.id===p); return row ? aFmt(Number(row.dailyTarget)/1e18, 2) : (p==='mini120'?'3.33':'16.67'); };
    const DAY_MS = 86400_000;
    const walletShort = (w)=> !w ? '-' : w.length>=16 ? w.slice(0,8)+'…'+w.slice(-6) : w;
    const rows = items.length===0
      ? `<tr><td colspan="10" class="admin-empty">暂无矿机记录（请先赠送矿机或切换筛选条件）</td></tr>`
      : items.map(r=>{
          const dl = r.status==='active' && r.expiresAt ? Math.max(0, Math.floor((r.expiresAt-Date.now())/DAY_MS)) : 0;
          const warn = r.status==='active' && dl<=3;
          return `<tr data-mid="${esc(r.id)}">
            <td><code style="font-size:11px" title="${esc(r.id)}">${esc(r.id.slice(0,22))}</code></td>
            <td><code title="${esc(r.wallet||'')}">${esc(walletShort(r.wallet))}</code></td>
            <td>${r.plan==='mini120'?aPill('#50d2c2','Mini 矿机'):r.plan==='pro1500'?aPill('#8a7dff','Pro 矿机'):esc(r.plan)}</td>
            <td style="text-align:right">${r.status==='active'?aPill('#50d2a8','● active'):aPill('#81918e','● completed')}</td>
            <td style="text-align:right">${aFmt(r.dailyTarget,2)} <small>AIX/日</small></td>
            <td style="text-align:right">${aFmt(r.total,0)} AIX</td>
            <td style="text-align:right">${aFmt(r.totalEarned,2)}<br><small style="color:#50d2c2">${aFmt(r.remaining,2)} 待 · ${Number(r.progressPct||0).toFixed(1)}%</small></td>
            <td style="text-align:right">${new Date(r.startedAt||0).toLocaleDateString('zh-CN')}</td>
            <td style="text-align:right">${r.expiresAt ? new Date(r.expiresAt).toLocaleDateString('zh-CN') + (warn ? ' <b style="color:var(--admin-red)">'+dl+'天</b>' : '') : '-'}</td>
            <td style="white-space:nowrap">${r.status==='active' ? `<button type="button" class="admin-table-action reject" data-mact="expire">⏹ 过期</button>` : '-'}</td>
          </tr>`;
        }).join('');
    root.innerHTML = `
      <div class="admin-a-grid">
        ${stat('矿机总数', String(total), '#50d2c2')}
        ${stat('Active 数', String(aActive), '#f6c454')}
        ${stat('已完成', String(aDone), '#81918e')}
        ${stat('待产出≈', aFmt(items.reduce((a,r)=>a + (r.status==='active'?Number(r.remaining||0):0), 0), 0) + ' A', '#8a7dff')}
      </div>
      <div class="admin-a-card">
        <h3>赠送矿机</h3>
        <p>矿机赠送已移至独立资金后台。</p>
        <button type="button" class="admin-primary-button" id="am-open-funds">打开资金后台</button>
      </div>
      <div class="admin-a-card">
        <h3>👤 设置用户等级（A1-A10）</h3>
        <div class="admin-a-form-grid" style="grid-template-columns: 2fr 1fr auto;gap:12px;align-items:flex-end">
          <label>用户钱包<input id="am-level-wallet" type="text" placeholder="0x..."></label>
          <label>等级<select id="am-level-val">${Array.from({length:10},(_,i)=>`<option value="${i+1}">A${i+1}</option>`).join('')}</select></label>
          <label style="align-self:flex-end">${aBtn('👤 设置等级', { id:'am-level-set' })}</label>
        </div>
      </div>
      <div class="admin-a-card">
        <h3>📈 矿机激活进度（前台展示）</h3>
        <p>直接填「目标进度 %」即可，会自动换算成「已激活人数」保存。前台进度条 = 已激活人数 ÷ 激活名额总数；已激活人数 = 真实确认激活数 + 后台补量，真实新增激活仍会继续累加（进度会随之缓慢上浮，要锁定时重新保存一次）。</p>
        <div class="admin-a-form-grid" style="grid-template-columns:1fr 1fr 1fr auto;gap:12px;align-items:flex-end">
          <label>目标进度 %<input id="am-prog-pct" type="number" min="0" max="100" step="0.01" value="${progPct}"></label>
          <label>激活名额总数<input id="am-prog-cap" type="number" min="1" step="1" value="${progCap}"></label>
          <label>已激活人数（前台显示）<input id="am-prog-count" type="number" min="0" step="1" value="${progCount}"></label>
          <label style="align-self:flex-end">${aBtn('💾 保存进度', { id:'am-prog-save' })}</label>
        </div>
        <div class="admin-inline-status" id="am-prog-status">真实确认激活 ${progReal} 人 · 当前前台显示 ${progCount} / ${progCap}（${progPct}%）</div>
      </div>
      <div class="admin-a-card">
        <h3>🔎 搜索筛选</h3>
        <div class="admin-a-form-grid" style="grid-template-columns: 2fr 1fr 1fr auto;gap:12px;align-items:flex-end">
          <label>钱包地址<input id="am-f-w" type="text" placeholder="0x... 留空=全部"></label>
          <label>状态<select id="am-f-s"><option value="">全部</option><option value="active">Active</option><option value="completed">Completed</option></select></label>
          <label>套餐<select id="am-f-p"><option value="">全部</option><option value="mini120">Mini 矿机</option><option value="pro1500">Pro 矿机</option></select></label>
          <label style="align-self:flex-end">${aBtn('🔎 刷新列表', { id:'am-refresh' })}</label>
        </div>
      </div>
      <div class="admin-table-scroll" style="margin-top:4px">
        <table class="admin-table"><thead><tr>
          <th>矿机 ID</th><th>用户钱包</th><th>套餐</th><th style="text-align:right">状态</th>
          <th style="text-align:right">日产</th><th style="text-align:right">总额度</th><th style="text-align:right">已产出/进度</th>
          <th style="text-align:right">开始</th><th style="text-align:right">到期</th><th style="text-align:right">操作</th>
        </tr></thead><tbody id="am-tbody">${rows}</tbody></table>
      </div>
    `;
    // 事件
    const $id = (id)=>document.getElementById(id);
    const mark = (id,msg)=>{const el=$id(id);if(!el)return;const t=el.textContent;el.disabled=true;el.textContent=msg;setTimeout(()=>{el.textContent=t;el.disabled=false;},1500);toast(msg);};
    $id('am-open-funds')?.addEventListener('click', () => window.open('/funds-admin.html', '_blank', 'noopener,noreferrer'));
    $id('am-level-set')?.addEventListener('click', async ()=>{
      const w=String($id('am-level-wallet').value||'').trim();
      const lv=$id('am-level-val').value;
      if(!w)return toast('请输入钱包地址');
      if(!await confirmDialog(`确认将 ${shortAddress(w)} 等级设置为 A${lv}？`))return;
      try{ await api(`/api/admin/users/${encodeURIComponent(w)}/level`,{method:'POST',body:JSON.stringify({level:Number(lv)})});
        mark('am-level-set',`✓ 已设为 A${lv}`);
      }catch(e){toast(e.message);}
    });
    // 填百分比自动换算人数；改人数/名额反向回算百分比
    const syncPctFromCount = ()=>{
      const cap = Number($id('am-prog-cap').value);
      const count = Number($id('am-prog-count').value);
      if(!Number.isFinite(cap) || cap < 1 || !Number.isFinite(count)) return;
      $id('am-prog-pct').value = Math.min(100, count / cap * 100).toFixed(2);
    };
    $id('am-prog-pct')?.addEventListener('input', ()=>{
      const cap = Number($id('am-prog-cap').value);
      const pct = Number($id('am-prog-pct').value);
      if(!Number.isFinite(cap) || cap < 1 || !Number.isFinite(pct)) return;
      $id('am-prog-count').value = Math.round(cap * Math.max(0, Math.min(100, pct)) / 100);
    });
    $id('am-prog-cap')?.addEventListener('input', syncPctFromCount);
    $id('am-prog-count')?.addEventListener('input', syncPctFromCount);
    $id('am-prog-save')?.addEventListener('click', async ()=>{
      const cap = Number($id('am-prog-cap').value);
      const count = Number($id('am-prog-count').value);
      const st = $id('am-prog-status');
      if(!Number.isFinite(cap) || cap < 1) return toast('激活名额总数需 ≥ 1');
      if(!Number.isFinite(count) || count < 0) return toast('已激活人数需 ≥ 0');
      if(count > cap) return toast('已激活人数不能大于名额总数');
      st.textContent = '保存中...';
      try{
        await aApi('/activation/progress',{method:'POST',body:JSON.stringify({cap, activatedCount:count})});
        toast('✓ 已保存激活进度');
        await loadAMiner();
      }catch(e){ st.textContent = e.message; toast(e.message); }
    });
    $id('am-refresh')?.addEventListener('click', ()=>{
      const q=new URLSearchParams({limit:500});
      ['w','s','p'].forEach(k=>{const v=$id('am-f-'+k)?.value; if(v) q.set(k==='w'?'wallet':k==='s'?'status':'plan',v);});
      loadAMiner(q.toString());
    });
    $id('am-tbody')?.addEventListener('click', async(e)=>{
      const b = e.target.closest('button[data-mact]'); if(!b)return;
      const tr=b.closest('tr[data-mid]'); if(!tr)return; const mid=tr.dataset.mid;
      try{
        if(b.dataset.mact==='expire'){ if(!await confirmDialog('确认强制过期这台矿机？（会补齐剩余 A 尾差给用户）')) return; await aApi('/miners/expire',{method:'POST',body:JSON.stringify({minerId:mid, payRemaining:true})}); toast('✓ 已强制过期'); await loadAMiner();}
      }catch(err){toast(err.message);}
    });
  }

  // 刷新按钮
  byId('admin-a-kline-refresh')?.addEventListener('click', loadAKline);
  byId('admin-a-miner-refresh')?.addEventListener('click', () => loadAMiner());

  window.AdminCommunity?.init({api,toast});
  window.AdminLottery?.init({api,toast});
  api('/api/admin/session').then(session => session.authenticated ? showApp(session) : showLogin()).catch(showLogin);
})();
