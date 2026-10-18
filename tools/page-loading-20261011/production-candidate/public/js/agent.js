(function () {
  const byId = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
  const amount = value => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:6 });
  const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12:false }) : '-';
  const shortAddress = value => { const t = String(value || ''); return t.length > 18 ? `${t.slice(0,8)}...${t.slice(-6)}` : t || '-'; };
  const statusText = {
    pending:'待确认', confirmed:'已确认', rejected:'已拒绝', expired:'已过期',
    pending_review:'待审核', pending_funds:'待补款', pending_auto:'自动队列', processing:'准备出款', signed:'等待广播',
    broadcast:'链上确认中', payout_failed:'出款失败', paid:'已支付', failed:'失败', refunded:'失败已退回',
  };
  const statusClass = s => ['confirmed','paid','refunded'].includes(s) ? 'good'
    : ['pending','pending_review','pending_funds','pending_auto','processing','signed','broadcast'].includes(s) ? 'warn'
      : ['rejected','expired','failed','payout_failed'].includes(s) ? 'bad' : '';

  let currentPage = 'overview';
  let cache = { dashboard:null, users:[], deposits:[], withdrawals:[], rewards:null };

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { credentials:'same-origin', ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && path !== '/api/agent/login') { showLogin(); }
      throw new Error(payload?.error || `请求失败 (${response.status})`);
    }
    return payload;
  }

  function toast(message = '') {
    const node = byId('agent-global-status');
    if (!node) return;
    node.textContent = message;
    node.classList.toggle('show', Boolean(message));
    clearTimeout(toast.timer);
    if (message) toast.timer = setTimeout(() => { node.textContent = ''; node.classList.remove('show'); }, 3000);
  }

  function showLogin() {
    byId('agent-app').hidden = true;
    byId('agent-login-view').hidden = false;
    byId('agent-password').value = '';
    setTimeout(() => byId('agent-username').focus(), 0);
  }
  function showApp() {
    byId('agent-login-view').hidden = true;
    byId('agent-app').hidden = false;
  }

  function navigate(page) {
    currentPage = page;
    const titles = { overview:'团队概览', users:'下级用户', deposits:'充值记录', withdrawals:'提现记录', rewards:'返佣记录' };
    document.querySelectorAll('[data-agent-page]').forEach(b => b.classList.toggle('active', b.dataset.agentPage === page));
    document.querySelectorAll('[data-agent-panel]').forEach(p => p.classList.toggle('active', p.dataset.agentPanel === page));
    byId('agent-page-title').textContent = titles[page] || '代理后台';
    window.scrollTo({ top:0, behavior:'auto' });
    renderPage();
  }

  function renderPage() {
    if (currentPage === 'overview') renderOverview();
    else if (currentPage === 'users') renderUsers();
    else if (currentPage === 'deposits') renderDeposits();
    else if (currentPage === 'withdrawals') renderWithdrawals();
    else if (currentPage === 'rewards') renderRewards();
  }

  function renderOverview() {
    const s = cache.dashboard?.summary || {};
    byId('metric-downline-users').textContent = s.downlineUsers ?? 0;
    byId('metric-real-users').textContent = s.realUsers ?? 0;
    byId('metric-total-deposited').textContent = amount(s.totalDepositedUsdt);
    byId('metric-total-balance').textContent = amount(s.totalPlatformBalanceUsdt);
    byId('metric-total-withdrawn').textContent = amount(s.totalWithdrawnUsdt);
    byId('metric-earned').textContent = amount(s.earnedUsdt);
    byId('metric-claimable').textContent = `待领 ${amount(s.claimableUsdt)} USDT`;
    byId('agent-updated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12:false })}`;
  }

  function renderUsers() {
    const search = (byId('agent-user-search')?.value || '').toLowerCase();
    const realOnly = byId('agent-real-only')?.checked;
    let rows = cache.users || [];
    if (search) rows = rows.filter(u => u.address.toLowerCase().includes(search));
    if (realOnly) rows = rows.filter(u => u.isRealUser);
    byId('agent-user-count').textContent = `${rows.length} 位用户`;
    byId('agent-users-body').innerHTML = rows.length ? rows.map(u => `
      <tr>
        <td style="font-family:monospace;font-size:12px" title="${esc(u.address)}">${esc(shortAddress(u.address))}</td>
        <td>A${u.level || 1}</td>
        <td>${amount(u.confirmedDepositTotal)} <small>USDT</small></td>
        <td>${amount(u.platformUsdtBalance)} <small>USDT</small></td>
        <td>${date(u.createdAt)}</td>
        <td>${date(u.lastDepositAt)}</td>
      </tr>`).join('') : '<tr><td colspan="6" style="text-align:center;color:var(--admin-muted)">暂无数据</td></tr>';
  }

  function renderDeposits() {
    const rows = cache.deposits || [];
    byId('agent-deposit-count').textContent = `${rows.length} 笔`;
    byId('agent-deposits-body').innerHTML = rows.length ? rows.map(r => `
      <tr>
        <td style="font-family:monospace;font-size:12px" title="${esc(r.wallet)}">${esc(shortAddress(r.wallet))}</td>
        <td>${esc(r.networkName || r.network)}</td>
        <td>${amount(r.amount)} <small>${esc(r.asset)}</small></td>
        <td><span class="admin-status ${statusClass(r.status)}">${esc(statusText[r.status] || r.status)}</span></td>
        <td>${date(r.confirmedAt || r.createdAt)}</td>
      </tr>`).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--admin-muted)">暂无数据</td></tr>';
  }

  function renderWithdrawals() {
    const rows = cache.withdrawals || [];
    byId('agent-withdrawal-count').textContent = `${rows.length} 笔`;
    byId('agent-withdrawals-body').innerHTML = rows.length ? rows.map(r => `
      <tr>
        <td style="font-family:monospace;font-size:12px" title="${esc(r.wallet)}">${esc(shortAddress(r.wallet))}</td>
        <td>${esc(r.networkName || r.network)}</td>
        <td>${amount(r.amount)} <small>${esc(r.asset)}</small></td>
        <td><span class="admin-status ${statusClass(r.status)}">${esc(statusText[r.status] || r.status)}</span></td>
        <td>${date(r.processedAt || r.createdAt)}</td>
      </tr>`).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--admin-muted)">暂无数据</td></tr>';
  }

  function renderRewards() {
    const data = cache.rewards || { earnedUsdt:'0', claimableUsdt:'0', rows:[] };
    byId('reward-earned').textContent = amount(data.earnedUsdt);
    byId('reward-claimable').textContent = amount(data.claimableUsdt);
    const kindText = { direct_reward:'直推返佣', indirect_reward:'间推返佣', mining_reward:'矿机返佣', ai_managed:'AI 跟单返佣' };
    const sourceText = { trading_fee:'交易手续费', ai_managed:'AI 跟单' };
    byId('agent-rewards-body').innerHTML = data.rows.length ? data.rows.map(r => `
      <tr>
        <td style="font-family:monospace;font-size:12px" title="${esc(r.sourceWallet)}">${esc(shortAddress(r.sourceWallet))}</td>
        <td>${esc(kindText[r.kind] || r.kind || '-')}</td>
        <td>${esc(sourceText[r.source] || r.source || '-')}</td>
        <td>${amount(r.amountUsdt)} <small>USDT</small></td>
        <td><span class="admin-status ${r.status === 'pending' ? 'warn' : 'good'}">${r.status === 'pending' ? '待领取' : '已领取'}</span></td>
        <td>${date(r.createdAt)}</td>
      </tr>`).join('') : '<tr><td colspan="6" style="text-align:center;color:var(--admin-muted)">暂无返佣记录</td></tr>';
  }

  async function loadAll() {
    try {
      byId('agent-updated').textContent = '加载中...';
      const [dash, users, deposits, withdrawals, rewards] = await Promise.all([
        api('/api/agent/dashboard'),
        api('/api/agent/users'),
        api('/api/agent/deposits'),
        api('/api/agent/withdrawals'),
        api('/api/agent/rewards'),
      ]);
      cache.dashboard = dash;
      cache.users = users.users || [];
      cache.deposits = deposits.rows || [];
      cache.withdrawals = withdrawals.rows || [];
      cache.rewards = rewards;
      renderPage();
      toast('数据已刷新');
    } catch (err) { toast(err.message); }
  }

  // 登录
  byId('agent-login-form').addEventListener('submit', async e => {
    e.preventDefault();
    byId('agent-login-error').textContent = '';
    try {
      const result = await api('/api/agent/login', {
        method:'POST',
        body: JSON.stringify({ username: byId('agent-username').value.trim(), password: byId('agent-password').value }),
      });
      byId('agent-current-user').textContent = result.username;
      byId('agent-current-wallet').textContent = result.walletAddress;
      showApp();
      await loadAll();
    } catch (err) { byId('agent-login-error').textContent = err.message; }
  });

  byId('agent-logout').addEventListener('click', async () => {
    try { await api('/api/agent/logout', { method:'POST' }); } catch {}
    showLogin();
  });

  byId('agent-refresh').addEventListener('click', loadAll);
  byId('agent-user-search')?.addEventListener('input', renderUsers);
  byId('agent-real-only')?.addEventListener('change', renderUsers);

  document.querySelectorAll('[data-agent-page]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.agentPage)));

  // 侧边栏（移动端）
  const sidebar = byId('agent-sidebar');
  byId('agent-menu-toggle').addEventListener('click', () => sidebar.classList.add('open'));
  byId('agent-sidebar-backdrop').addEventListener('click', () => sidebar.classList.remove('open'));

  // 启动：检查会话
  (async () => {
    try {
      const session = await api('/api/agent/session');
      if (session.authenticated) {
        byId('agent-current-user').textContent = session.username;
        byId('agent-current-wallet').textContent = session.walletAddress;
        showApp();
        await loadAll();
      } else {
        showLogin();
      }
    } catch { showLogin(); }
  })();
})();
