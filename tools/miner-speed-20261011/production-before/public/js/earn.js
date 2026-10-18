(() => {
  const P = Portal;
  let currentSubTab = 'activation';
  let plansCache = null;
  let profileCache = null;
  let refProfileCache = null;
  let plansRequest = null;
  // 加载失效序号：钱包连接/登录完成会强制重载本页，旧加载即使仍在请求中也不得再写 DOM，
  // 否则慢网下旧加载结束时会把游客态覆盖到新的已登录内容上。
  let loadSeq = 0;

  // profile 数据 stale-while-revalidate 缓存：二次进站秒开矿机/团队数据，后台静默更新。
  // 30 秒上限：矿机产出/团队数据是动态的，不能缓存太久。
  const PROFILE_CACHE_KEY = 'axix:profile:v1';
  const PROFILE_CACHE_MAX_MS = 120_000;
  function readProfileCache(addr) {
    try {
      const raw = localStorage.getItem(PROFILE_CACHE_KEY);
      if (!raw) return null;
      const { t, addr: cachedAddr, data } = JSON.parse(raw);
      if (!data || !Number.isFinite(t) || Date.now() - t > PROFILE_CACHE_MAX_MS) return null;
      // 必须有地址且完全匹配才命中：防止不同钱包看到别人的数据
      if (!addr || !cachedAddr || cachedAddr.toLowerCase() !== addr.toLowerCase()) return null;
      return data;
    } catch { return null; }
  }
  function writeProfileCache(addr, data) {
    try { localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({ t: Date.now(), addr, data })); } catch {}
  }
  function clearProfileCache() {
    try { localStorage.removeItem(PROFILE_CACHE_KEY); } catch {}
  }

  // 钱包内置 DApp 浏览器经 Cloudflare 时常握手挂起：所有请求带超时，避免无限等待。
  // 手动 AbortController（不依赖 AbortSignal.timeout，兼容老内核 webview）。
  const fetchWithTimeout = async (url, options, timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs);
    try {
      return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('网络较慢，请求超时，请稍后重试');
      throw new Error('网络连接失败，请检查网络后重试');
    } finally { clearTimeout(timer); }
  };
  const api = async (path, options = {}, timeoutMs = 15000) => {
    const response = await fetchWithTimeout(`/api/a-token/${path}`, options, timeoutMs);
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error('矿机服务暂时不可用，请稍后重试'); }
    if (!response.ok) throw new Error(payload.error || 'AIX 代币服务请求失败');
    return payload;
  };
  const authApi = async (path, options = {}, timeoutMs = 15000) => {
    if (!window.currentWalletProfile?.authenticated && window.currentWalletConnection?.address
      && typeof ensurePlatformSession === 'function') await ensurePlatformSession();
    if (!window.currentWalletProfile?.authenticated) throw new Error('SESSION_REQUIRED');
    return api(path, options, timeoutMs);
  };
  const fmt = (v, d = 4) => Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-US', { maximumFractionDigits: d }) : '0';
  const fmtA = (v) => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : '0.00'; };
  // 前端单位清洗：把文本中所有「N A」或「NA」连写的旧单位标签替换成「N AIX」。
  // 仅用于显示层，不改动数值、不做换算，保持 fmtA(v) 原值 1:1。
  const cleanAixText = (s) => {
    if (s == null) return s;
    let t = String(s);
    // 浮点/整数 + 可选空格 + A，后面不是 X 或 I（避免误改 AIX、AIX 缩写）
    t = t.replace(/(\d+\.?\d*)\s*A(?![XI])/g, '$1 AIX');
    // 修掉前一次替换后可能产生的 AIXIX 重复（防双替换保护）
    t = t.replace(/AIXIX/g, 'AIX');
    return t;
  };
  const timeLeft = (ms) => {
    if (!ms || ms <= 0) return '已到期';
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    if (d > 0) return `${d}天${h}小时`;
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}小时${m}分`;
  };
  const escapeHtml = P.esc;
  const shortAddr = (a) => {
    if (!a) return '—';
    const s = String(a);
    return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
  };

  // 激活页顶部：参考设计 —— 我的上级地址 + 直推/团队人数大卡片 + 邀请链接
  function teamSummaryCard() {
    const team = profileCache?.teamLevel;
    const directCount = team?.directCount || 0;
    const teamCount = team?.teamCount || 0;
    const referrer = team?.directReferrer || null;
    const referrerHtml = referrer
      ? `<code title="${escapeHtml(referrer)}" class="ts-upline-addr">${escapeHtml(shortAddr(referrer))}</code>`
      : '<span class="ts-upline-none">无推荐人</span>';
    const refLink = refProfileCache?.code ? earnRefLink() : '';
    const inviteHtml = refLink
      ? `<div class="ts-invite">
          <span class="ts-invite-label">🔗 我的邀请链接</span>
          <div class="ts-invite-row">
            <code class="ts-invite-link" title="${escapeHtml(refLink)}">${escapeHtml(refLink)}</code>
            <button class="ts-invite-btn" onclick="window.earnCopyLink()">复制</button>
          </div>
        </div>`
      : '';
    return `
      <div class="ts-hero-card">
        <div class="ts-hero-top">
          <div class="ts-upline">
            <span class="ts-upline-label">我的上级</span>
            ${referrerHtml}
          </div>
        </div>
        <div class="ts-stat-grid">
          <div class="ts-stat-cell">
            <div class="ts-stat-num">${directCount}<small>人</small></div>
            <div class="ts-stat-label">直推人数</div>
            <span class="ts-stat-icon">👥</span>
          </div>
          <div class="ts-stat-cell">
            <div class="ts-stat-num">${teamCount.toLocaleString()}<small>人</small></div>
            <div class="ts-stat-label">团队人数</div>
            <span class="ts-stat-icon">🌐</span>
          </div>
        </div>
        ${inviteHtml}
      </div>`;
  }

  // 直推明细列表：参考设计的紧凑卡片式列表
  function directReferralList() {
    const team = profileCache?.teamLevel;
    const directs = team?.directs || [];
    if (directs.length === 0) {
      return `<div class="ts-empty">暂无直推用户，分享邀请链接邀请好友加入</div>`;
    }
    const rows = directs.slice(0, 30).map(d => {
      const lvlColor = d.level >= 9 ? '#f26c78' : d.level >= 7 ? '#f6c454' : d.level >= 4 ? '#50d2c2' : '#81918e';
      const lvlText = d.level > 0 ? 'A' + d.level : '未达标';
      return `
        <div class="dr-row">
          <div class="dr-avatar">${d.wallet ? String(d.wallet).slice(2, 4).toUpperCase() : '??'}</div>
          <div class="dr-info">
            <code class="dr-addr" title="${escapeHtml(d.wallet || '')}">${escapeHtml(d.shortAddress || shortAddr(d.wallet))}</code>
            <div class="dr-meta">
              <span class="dr-lvl" style="color:${lvlColor}">${lvlText}</span>
              <span class="dr-mine">${d.minerCount || 0} 台矿机</span>
              <span class="dr-bal">${fmtA(d.personalA)} AIX</span>
            </div>
          </div>
        </div>`;
    }).join('');
    return `
      <div class="dr-list">
        ${rows}
      </div>`;
  }

  function render() {
    const root = document.getElementById('tab-earn');
    root.innerHTML = `<div class="portal-shell">
      ${P.header('AxiX矿机', 'AIX 生态：激活矿机 · 质押收益')}
      <div class="earn-sub-tabs">
        <button class="earn-sub-tab${currentSubTab === 'activation' ? ' active' : ''}" onclick="window.earnSwitch('activation')">激活</button>
        <button class="earn-sub-tab${currentSubTab === 'miner' ? ' active' : ''}" onclick="window.earnSwitch('miner')">矿机</button>
        <button class="earn-sub-tab${currentSubTab === 'staking' ? ' active' : ''}" onclick="window.earnSwitch('staking')">质押</button>
        <button class="earn-sub-tab${currentSubTab === 'team' ? ' active' : ''}" onclick="window.earnSwitch('team')">团队</button>
      </div>
      <div id="earn-content">${P.loading(6)}</div>
    </div>`;
  }

  // ── 矿机总览（仅在「矿机」tab 内展示） ──
  const fmtNum = (s, digits = 2) => { const n = Number(s || '0'); return isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: digits }) : '0'; };

  function poolOverviewHtml() {
    const authed = !!window.currentWalletProfile?.authenticated;
    if (!authed) {
      return `<div class="pool-overview">
          <div class="pool-section">
            <div class="pool-section-title">⛏ 我的矿机总览</div>
            <div class="ev2-empty" style="padding:18px">连接钱包并登录平台后，这里只显示你自己的矿机数据</div>
          </div>
        </div>`;
    }
    const miners = profileCache?.miners || [];
    const active = miners.filter(m => m.status === 'active');
    const sum = (arr, field) => arr.reduce((s, m) => s + Number(m[field] || 0), 0);
    const mActive = active.length;
    const mHashrate = sum(active, 'dailyTarget');
    const mToday = sum(miners, 'dayEarned');
    const mPlanned = sum(active, 'remaining');
    const mLifetime = sum(miners, 'totalEarned');
    const mTeamTotal = Number(profileCache?.teamLevel?.totalEarnedA || 0);
    return `
      <div class="pool-overview">
        <div class="pool-section">
          <div class="pool-section-title">⛏ 我的矿机总览</div>
          <div class="pool-grid">
            <div class="pool-cell">
              <div class="pool-cell-label">我的活跃矿机</div>
              <div class="pool-cell-value">${mActive} <small>台</small></div>
            </div>
            <div class="pool-cell">
              <div class="pool-cell-label">我的算力</div>
              <div class="pool-cell-value" style="color:#50d2b8">${fmtNum(mHashrate, 2)} <small>AIX/日</small></div>
            </div>
            <div class="pool-cell">
              <div class="pool-cell-label">今日已到账</div>
              <div class="pool-cell-value" style="color:#50d2b8">${fmtNum(mToday, 2)} <small>AIX</small></div>
            </div>
            <div class="pool-cell">
              <div class="pool-cell-label">运行中待产出</div>
              <div class="pool-cell-value" style="color:#f59e0b">${fmtNum(mPlanned, 2)} <small>AIX</small></div>
            </div>
            <div class="pool-cell">
              <div class="pool-cell-label">累计已到账</div>
              <div class="pool-cell-value">${fmtNum(mLifetime, 2)} <small>AIX</small></div>
            </div>
            <div class="pool-cell">
              <div class="pool-cell-label">累计团队分润</div>
              <div class="pool-cell-value" style="color:#f6c454">${fmtNum(mTeamTotal, 2)} <small>AIX</small></div>
            </div>
          </div>
        </div>
      </div>`;
  }

  function refreshPoolOverview() {
    const host = document.getElementById('miner-pool-overview');
    if (!host) return;
    try {
      host.innerHTML = poolOverviewHtml();
    } catch (e) {
      host.innerHTML = `<div class="ev2-empty" style="padding:18px">矿机数据加载失败：${escapeHtml(e.message || e)}</div>`;
    }
  }

  let poolOverviewTimer = null;
  let earnRefreshBusy = false;
  function startPoolOverviewAutoRefresh() {
    if (poolOverviewTimer) clearInterval(poolOverviewTimer);
    // 每分钟获取最新到账数据；表单操作期间不重绘，避免清空用户输入。
    poolOverviewTimer = setInterval(async () => {
      if (document.hidden) return;
      if (!document.getElementById('tab-earn')?.classList.contains('active')) return;
      if (!window.currentWalletProfile?.authenticated || earnRefreshBusy) return;
      if (!['miner', 'team'].includes(currentSubTab)) return;
      if (document.activeElement?.closest('input, select, textarea')) return;
      const wallet = window.currentWalletConnection?.address;
      const tab = currentSubTab;
      earnRefreshBusy = true;
      try {
        const fresh = await authApi('profile');
        if (tab === 'team') fresh.teamLevel = await authApi('team/profile');
        if (window.currentWalletProfile?.authenticated && window.currentWalletConnection?.address === wallet && currentSubTab === tab) { profileCache = fresh; await renderSubTab(); }
      } catch {} finally { earnRefreshBusy = false; }
    }, 60_000);
  }

  // ── 套餐配置 stale-while-revalidate：先用 localStorage 旧数据立即渲染，后台拉新覆盖 ──
  // plans 为准静态配置（套餐/开关），缓存上限 24h；开关类状态以后端接口实际返回为准（后端强制拦截）
  const PLANS_CACHE_KEY = 'axix:plans:v1';
  const PLANS_CACHE_MAX_MS = 86_400_000;
  function readPlansCache() {
    try {
      const raw = localStorage.getItem(PLANS_CACHE_KEY);
      if (!raw) return null;
      const { t, data } = JSON.parse(raw);
      if (!data || !Number.isFinite(t) || Date.now() - t > PLANS_CACHE_MAX_MS) return null;
      return data;
    } catch { return null; }
  }
  function writePlansCache(data) {
    try { localStorage.setItem(PLANS_CACHE_KEY, JSON.stringify({ t: Date.now(), data })); } catch {}
  }

  // plans 是准静态套餐配置；弱网完全拉不到时用内置兜底先渲染，激活开关以后端实际拦截为准。
  const FALLBACK_PLANS = {
    activation: [
      { plan: '1', minerPlan: 'mini120', bnb: '0.002', name: 'Mini 矿机', label: '0.002 BNB · Mini 矿机 · 100A / 30天 · 每人限购 1 份' },
      { plan: '2', minerPlan: 'pro1500', bnb: '0.05', name: 'Pro 矿机', label: '0.05 BNB · Pro 矿机 · 1500A / 90天 · 每人限购 1 份' }
    ],
    activationMeta: { cap: 1000000, activatedCount: 0 },
    collectionAddress: '0xa71e0Cfb92643Ccf1fADcD45FcFb29B7b39c56E6',
    chainId: 56,
    confirmations: 12,
    activationEnabled: true,
    withdrawEnabled: false,
    staking: [
      { planId: 'current', label: '活期', days: 0, dailyRateBps: 30, flexible: true },
      { planId: 's30', label: '1号 30天', days: 30, dailyRateBps: 80, flexible: false },
      { planId: 's60', label: '2号 60天', days: 60, dailyRateBps: 100, flexible: false },
      { planId: 's90', label: '3号 90天', days: 90, dailyRateBps: 120, flexible: false }
    ],
    miner: [ { plan: 'mini120', days: 30 }, { plan: 'pro1500', days: 90 } ],
    _fallback: true
  };
  // 单次 8s 超时，失败再试一次；仍失败由调用方决定是否启用兜底。
  const fetchPlansFresh = () => api('plans', {}, 8000).catch(() => api('plans', {}, 8000));
  function refreshPlansInBackground() {
    if (plansRequest) return plansRequest;
    plansRequest = fetchPlansFresh().then(fresh => {
      plansCache = fresh;
      writePlansCache(fresh);
      if (document.getElementById('tab-earn')?.classList.contains('active')
        && !document.activeElement?.closest('input, select, textarea')) renderSubTab();
    }).catch(() => { if (plansCache?._fallback) startPlansRetry(); })
      .finally(() => { plansRequest = null; });
    return plansRequest;
  }
  let plansRetryTimer = null;
  function startPlansRetry() {
    if (plansRetryTimer) return;
    let tries = 0;
    plansRetryTimer = setInterval(async () => {
      tries += 1;
      if (tries > 10 || !plansCache?._fallback) { clearInterval(plansRetryTimer); plansRetryTimer = null; return; }
      try {
        const fresh = await api('plans', {}, 8000);
        plansCache = fresh;
        writePlansCache(fresh);
        clearInterval(plansRetryTimer);
        plansRetryTimer = null;
        if (document.getElementById('tab-earn')?.classList.contains('active')
          && !document.activeElement?.closest('input, select, textarea')) renderSubTab();
      } catch {}
    }, 15000);
  }
  // 弱网提示：仅在使用内置兜底数据时出现，低调灰色小字，避免引起用户担心
  function slowNetworkNotice() {
    if (!plansCache?._fallback) return '';
    return '<div style="margin:0 0 10px;text-align:center;font-size:11px;color:#8a9794;opacity:.75;line-height:1.5">正在更新矿机方案，付款前会核对最新配置</div>';
  }

  async function load() {
    const seq = ++loadSeq;
    const stale = () => seq !== loadSeq;
    const host = document.getElementById('earn-content');
    if (!host) return;
    // 矿机/团队统计每分钟更新一次。
    startPoolOverviewAutoRefresh();
    try {
      if (!plansCache) {
        // Render immediately; the two network attempts may take 16 seconds on a weak connection.
        plansCache = readPlansCache() || Object.assign({}, FALLBACK_PLANS);
        refreshPlansInBackground();
      }
    } catch (e) {
      if (!stale()) host.innerHTML = P.error(e.message, "Portal.load('earn',true)");
      return;
    }
    // 已被更新的加载取代：静默退出，不再写 DOM。
    if (stale()) return;

    // 已登录：拉取个人数据后渲染。
    if (window.currentWalletProfile?.authenticated) {
      retryPendingActivation(); // 激活提交兜底：上次付款后提交失败的存单自动补交（异步，不阻塞渲染）
      // 先用 localStorage 缓存秒渲染，避免等待 API 时白屏
      const cachedProfile = readProfileCache(window.currentWalletConnection?.address);
      if (cachedProfile) {
        profileCache = cachedProfile;
      }
      // 先展示最新钱包状态，个人数据在后台刷新，不能把旧游客按钮留到请求结束。
      await renderSubTab();
      try {
        // Team/referral data is only needed when the team tab is opened.
        const [profileRes, teamRes, refRes] = await Promise.allSettled([
          authApi('profile', {}, 10000),
          currentSubTab === 'team' ? authApi('team/profile', {}, 8000) : Promise.resolve(null),
          currentSubTab === 'team' ? fetchWithTimeout('/api/referrals/profile', { headers: { 'Content-Type': 'application/json' } }, 8000)
            .then(r => r.ok ? r.json() : null) : Promise.resolve(null),
        ]);
        if (stale()) return;
        if (profileRes.status === 'fulfilled' && profileRes.value) {
          profileCache = profileRes.value;
          if (teamRes.status === 'fulfilled' && teamRes.value) profileCache.teamLevel = teamRes.value;
          writeProfileCache(window.currentWalletConnection?.address, profileCache);
        }
        if (refRes.status === 'fulfilled' && refRes.value) refProfileCache = refRes.value;
        if (stale()) return;
        await renderSubTab();
        return;
      } catch (e) {
        if (stale()) return;
        if (e.message === 'SESSION_REQUIRED') {
          // 登录态已失效：落到游客渲染
        } else {
          // profile 超时/失败不白屏：以空数据渲染，激活按钮可见；付款前有二次状态校验防重复支付
          profileCache = null;
          await renderSubTab();
          return;
        }
      }
    }

    // 未登录（含「已连接未签名」）：立即渲染游客内容，绝不阻塞等待可能很慢的签名登录。
    // 钱包初始化会自动发起登录；登录成功后 wallet.js refreshWalletDependents 强制重载本页，
    // 自动切换为已登录视图；用户也可直接点卡片上的按钮触发连接/签名，完成后同样自动刷新。
    profileCache = null;
    refProfileCache = null;
    if (!stale()) await renderSubTab();
  }

  // ── 浏览模式（游客） ──
  function renderGuestContent() {
    // 游客也可以先查看矿机页的布局与运行说明；未连接钱包时只隐藏个人矿机数据。
    if (currentSubTab === 'miner') return renderMiners();
    const stakePlans = plansCache?.staking || [];
    const activationPlans = plansCache?.activation || [];

    const walletConnected = Boolean(window.currentWalletConnection?.address);
    const walletConnectedHint = walletConnected
      ? '<div class="earn-wallet-hint" style="margin:0 0 10px;padding:10px 12px;border:1px solid rgba(80,210,194,.24);border-radius:10px;background:rgba(80,210,194,.08);color:#8fd8cf;text-align:center;font-size:12px">钱包已连接 · 请在钱包中确认身份后查看个人数据<button type="button" onclick="openPlatformAccount(this)" style="display:block;margin:8px auto 0;padding:7px 16px;border:1px solid #50d2c2;border-radius:8px;background:transparent;color:inherit;font:inherit">确认钱包</button></div>'
      : '';
    const stakeCards = stakePlans.map(p => stakeCardHtml(p)).join('');
    const planCards = activationPlans.map(p => activationCardHtml(p, false)).join('');

    const activatedCount = plansCache?.activationMeta?.activatedCount || 0;
    const cap = 1000000;
    const capPct = Math.min(100, (activatedCount / cap * 100)).toFixed(2);

    return `
      ${walletConnectedHint}
      <div class="earn-v2-head-banner">
        <h2>🎉 AIX 代币赚取生态 · 激活享矿机 · 质押赚收益</h2>
        <p>BSC 主网 · 链上付款 · 矿机自动日结</p>
      </div>

      ${slowNetworkNotice()}

      <div class="cap-wrap">
        <div class="cap-title">激活名额进度<small>激活用户赠送矿机，满额后关闭赠送</small></div>
        <div class="cap-bar"><div class="cap-fill" style="width:${capPct}%"></div></div>
      </div>

      <div class="earn-activation-v2-grid">${planCards || P.empty('暂无激活套餐')}</div>

      <div class="portal-section" style="border-radius:14px;overflow:hidden">
        <div class="portal-section-head"><h2>📦 质押收益</h2><span>日结到账 · 随进随出 · 固定档到期自动结清</span></div>
        <div class="stake-v2-grid" style="padding:16px">${stakeCards || P.empty('暂无质押套餐')}</div>
      </div>

      ${walletConnected
        ? '<div class="portal-gate"><strong>钱包已连接</strong><span>钱包已连接 · 请在钱包中确认身份后查看个人数据</span><button onclick="openPlatformAccount(this)">确认钱包</button></div>'
        : P.walletGate('连接并确认钱包后查看矿机、质押记录和团队数据')}
    `;
  }

  // ── 卡片构造 ──
  function activationCardHtml(p, showButton = true) {
    const isMini = p.plan === '1';
    const cls = isMini ? 'mini' : 'pro';
    const daily = isMini ? '3.33' : '16.67';
    const total = isMini ? '100' : '1500';
    const days = isMini ? '30' : '90';
    // 每个钱包每个套餐仅可激活一次：pending/confirmed 均占名额，按钮置灰防止重复支付 BNB
    const myAct = (profileCache?.activations || []).find(a => String(a.plan) === String(p.plan) && a.status !== 'rejected');
    const activationEnabled = plansCache?.activationEnabled !== false;
    let btnHtml;
    if (!activationEnabled) {
      btnHtml = `<button class="btn-activate" style="pointer-events:none;opacity:.55;cursor:default">矿机激活暂未开放</button>`;
    } else if (!showButton) {
      const connected = Boolean(window.currentWalletConnection?.address);
      const label = connected ? '钱包已连接 · 确认身份后激活' : '连接钱包后激活';
      btnHtml = `<button class="btn-activate" type="button" onclick="${connected ? 'openPlatformAccount' : 'connectWallet'}(this)">${label}</button>`;
    } else if (myAct?.status === 'confirmed') {
      btnHtml = `<button class="btn-activate" style="pointer-events:none;opacity:.55;cursor:default">已激活 ✔</button>`;
    } else if (myAct?.status === 'pending') {
      btnHtml = `<button class="btn-activate" style="pointer-events:none;opacity:.55;cursor:default">激活确认中…</button>`;
    } else {
      btnHtml = `<button class="btn-activate" onclick="window.earnActivate('${escapeHtml(p.plan)}')">立即激活 · ${escapeHtml(p.bnb)} BNB</button>`;
    }
    return `
      <div class="act-card ${cls}">
        <div class="act-banner ${cls}">
          <div class="act-banner-row">
            <span class="act-plan-tag ${cls}">${isMini ? '⚡ MINI 矿机' : '👑 PRO 矿机'}</span>
            <span class="portal-chip"><span class="act-copy-full">BNB 链上 · 限 ${days} 天</span><span class="act-copy-short">BNB · ${days}天</span></span>
          </div>
          <div class="act-miner-art ${cls}"><img src="/assets/miner-${isMini ? 'mini' : 'pro'}.svg?v=1" alt="${isMini ? 'Mini' : 'Pro'} 矿机" loading="lazy"></div>
          <div class="act-plan-title"><span class="act-copy-full">${escapeHtml(cleanAixText(p.label))}</span><span class="act-copy-short">${isMini ? 'Mini 矿机 · 30天' : 'Pro 矿机 · 90天'}</span></div>
          <div class="act-bnb">${escapeHtml(p.bnb)}<small>BNB</small></div>
          <div class="act-arrow">
            <strong><span class="act-copy-full">${total} AIX 总产出</span><span class="act-copy-short">总量 ${total} AIX</span></strong>
            <div class="arrow-box">→</div>
            <strong><span class="act-copy-full">日产 ${daily} AIX</span><span class="act-copy-short">日产 ${daily} AIX</span></strong>
          </div>
        </div>
        <div class="act-body">
          <div class="act-stats">
            <div class="stat-item"><span>矿机总产出</span><strong>${total} AIX</strong></div>
            <div class="stat-item"><span>日产目标</span><strong>${daily} AIX/天</strong></div>
            <div class="stat-item"><span>有效期</span><strong>${days} 天</strong></div>
          </div>
          ${btnHtml}
        </div>
      </div>`;
  }
  function stakeCardHtml(p, showButton = true) {
    const monthlyRate = p.days > 0 ? (Number(p.dailyRateBps) * 30 / 100).toFixed(0) : (Number(p.dailyRateBps) * 30 / 100).toFixed(1);
    const dailyRatePct = (Number(p.dailyRateBps) / 100).toFixed(2);
    const minMap = { current: '100 AIX', s30: '1,000 AIX', s60: '2,000 AIX', s90: '5,000 AIX' };
    const minA = minMap[p.planId] || '100 AIX';
    const periodLabel = p.flexible ? '随进随出' : p.days + ' 天到期';
    const expectedLabel = p.flexible ? '收益每日到账' : '到期共 ' + (Number(p.dailyRateBps) * Number(p.days) / 100).toFixed(1) + '%';
    const planClass = p.planId || 'current';
    const btnHtml = showButton
      ? `<button class="btn-stake" onclick="window.earnStake('${escapeHtml(p.planId)}')">立即质押</button>`
      : `<button class="btn-stake" style="opacity:.5;pointer-events:none">连接钱包</button>`;
    return `
      <div class="stake-card ${planClass}">
        <span class="stake-tag ${planClass}">${p.flexible ? '🟢 活期 · 灵活' : '🔒 固定档 · ' + p.days + ' 天'}</span>
        <div>
          <div class="stake-rate-big">${monthlyRate}%<small>月化</small></div>
          <div class="stake-sub-rate">日利率 <b>${dailyRatePct}%</b> · ${periodLabel}</div>
        </div>
        <div class="stake-meta">
          <div class="meta-item"><span>起投</span><b>${minA}</b></div>
          <div class="meta-item"><span>结算</span><b>每日自动</b></div>
          <div class="meta-item"><span>周期</span><b>${p.flexible ? '无固定期' : p.days + ' 天'}</b></div>
          <div class="meta-item"><span>预期</span><b>${expectedLabel}</b></div>
        </div>
        ${btnHtml}
      </div>`;
  }

  // ── 入口分发 ──
  async function renderSubTab() {
    const host = document.getElementById('earn-content');
    if (!host) return;
    if (!window.currentWalletProfile?.authenticated) {
      host.innerHTML = renderGuestContent();
      return;
    }
    switch (currentSubTab) {
      case 'activation': host.innerHTML = renderActivation(); break;
      case 'miner': host.innerHTML = renderMiners(); break;
      case 'staking': host.innerHTML = renderStaking(); break;
      case 'team': host.innerHTML = renderTeam(); break;
    }
  }

  // ── 激活 v2 ──
  function renderActivation() {
    const plans = (plansCache?.activation || []).map(p => ({ ...p, label: cleanAixText(p.label) }));
    const myActivations = profileCache?.activations || [];
    const collectionAddress = plansCache?.collectionAddress || '';
    const activatedCount = plansCache?.activationMeta?.activatedCount || 0;
    const cap = 1000000;
    const capPct = Math.min(100, (activatedCount / cap * 100)).toFixed(2);

    const planCards = plans.map(p => activationCardHtml(p, true)).join('');

    const myRows = myActivations.map(a => `<tr>
      <td data-label="套餐">${a.plan === '1' ? 'Mini 矿机 · 0.002 BNB' : 'Pro 矿机 · 0.05 BNB'}</td>
      <td data-label="规格"><span class="act-copy-full">${a.plan === '1' ? 'Mini 矿机（30天，日产约 3.3 AIX 共 100 AIX）' : 'Pro 矿机（90天，日产约 16.6 AIX 共 1500 AIX）'}</span><span class="act-copy-short">${a.plan === '1' ? '100 AIX · 30天' : '1500 AIX · 90天'}</span></td>
      <td data-label="交易哈希"><code title="${escapeHtml(a.txHash || '')}">${escapeHtml(String(a.txHash || '').slice(0, 12))}…</code></td>
      <td data-label="状态"><span class="status-chip ${a.status}">${({ pending: '链上确认中', confirmed: '已确认 ✔', rejected: '已驳回' })[a.status] || a.status}</span></td>
      <td data-label="确认时间">${a.confirmedAt ? new Date(a.confirmedAt).toLocaleString('zh-CN', { hour12: false }) : '-'}</td>
    </tr>`).join('') || `<tr><td colspan="5" class="ev2-empty"><div class="big-emoji">🎁</div>暂无激活记录，激活后矿机会立即出现在「矿机」页面</td></tr>`;

    return `
      <div class="earn-v2-head-banner">
        <h2>🚀 激活成为 AIX 生态用户</h2>
      </div>

      ${slowNetworkNotice()}

      ${teamSummaryCard()}

      <div class="cap-wrap">
        <div class="cap-title">激活名额进度<small>激活用户赠送矿机，满额后关闭赠送</small></div>
        <div class="cap-bar"><div class="cap-fill" style="width:${capPct}%"></div></div>
      </div>

      <div class="earn-activation-v2-grid">${planCards}</div>

      <div class="portal-section" style="border-radius:14px;overflow:hidden">
        <div class="portal-section-head">
          <h2>📒 我的激活记录</h2>
          <span>${myActivations.length} 条${!collectionAddress ? ' · 当前未配置链上自动校验，后台将人工确认' : ' · 链上自动校验（' + (plansCache?.confirmations || 12) + ' 区块确认）'}</span>
        </div>
        <div class="portal-table-wrap">
          <table class="portal-table">
            <thead><tr>
              <th>套餐</th><th>矿机规格</th><th>交易哈希</th><th>状态</th><th>确认时间</th>
            </tr></thead>
            <tbody>${myRows}</tbody>
          </table>
        </div>
      </div>

      <div class="portal-section" style="border-radius:14px;overflow:hidden;margin-top:18px">
        <div class="portal-section-head">
          <h2>👥 直推明细</h2>
          <span>${profileCache?.teamLevel?.directCount || 0} 位直推用户</span>
        </div>
        <div style="padding:12px">
          ${directReferralList()}
        </div>
      </div>`;
  }

  // ── 矿机 v2 ──
  function renderMiners() {
    const miners = profileCache?.miners || [];
    const totalRemaining = miners.reduce((sum, m) => sum + Number(m.remaining || 0), 0);

    const cards = miners.map(m => {
      const pct = Math.min(100, Number(m.progressPct || 0));
      const isMini = m.plan === 'mini120';
      const expired = m.status !== 'active';
      return `<div class="miner-card ${expired ? 'completed' : ''}">
        <div class="miner-card-accent ${isMini ? 'mini' : 'pro'}"></div>
        <div class="miner-head">
          <div class="miner-title">
            <span class="miner-icon">${isMini ? '⚡' : '👑'}</span>
            <div>
              <h3>${isMini ? 'Mini 矿机' : 'Pro 矿机'}</h3>
              <small class="miner-plan-desc">${isMini ? '30 天 · 日产 ' + fmtA(m.dailyTarget) + ' AIX' : '90 天 · 日产 ' + fmtA(m.dailyTarget) + ' AIX'}</small>
            </div>
          </div>
          <span class="state-pill ${expired ? 'done' : 'running'}">${expired ? '已完成' : '运行中'}</span>
        </div>
        <div class="miner-total-row">
          <span class="miner-total-label">总产出目标</span>
          <span class="miner-total-val">${fmtA(m.total)} <small>AIX</small></span>
        </div>
        <div class="miner-stats-row">
          <div class="miner-stat"><span>已到账产出</span><strong class="positive">${fmtA(m.totalEarned)} <small>AIX</small></strong></div>
          <div class="miner-stat"><span>剩余</span><strong>${fmtA(m.remaining)} <small>AIX</small></strong></div>
          <div class="miner-stat"><span>进度</span><strong>${pct.toFixed(2)}<small>%</small></strong></div>
        </div>
        <div class="progress-wrap">
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="progress-foot">
          <span class="miner-expire">${expired ? '已到期' : '⏱ ' + timeLeft(Number(m.expiresAt) - Date.now()) + ' 后到期'}</span>
        </div>
      </div>`;
    }).join('') || `<div class="ev2-empty" style="grid-column:1/-1"><div class="big-emoji">⛏️</div>暂无矿机<br><span style="margin-top:6px;display:block;font-size:12px;max-width:420px">去「激活」页面付款 0.002 / 0.05 BNB 激活，链上确认后矿机自动发放。</span></div>`;

    return `
      <section class="miner-page-hero">
        <div class="miner-page-hero-copy">
          <span class="miner-page-kicker">AIX 算力中心</span>
          <h2>让矿机持续工作</h2>
          <p>按已到账流水统计产出；北京时间每日结算，首个完整日结束后开始到账</p>
        </div>
        <img src="/assets/miner-rig.svg?v=1" alt="AIX 矿机" loading="lazy">
      </section>

      <div id="miner-pool-overview">${poolOverviewHtml()}</div>

      <div class="portal-section" style="border-radius:14px;overflow:hidden">
        <div class="portal-section-head">
          <h2>⛏️ 我的矿机列表</h2>
          <span>待产出合计 <b style="color:#50d2c2">${fmtA(totalRemaining)} AIX</b></span>
        </div>
        <div class="miner-v2-grid" style="padding:16px">${cards}</div>
      </div>`;
  }

  // ── 质押 v2 ──
  function renderStaking() {
    const stakePlans = plansCache?.staking || [];
    const myStakes = profileCache?.stakes || [];
    const activeStakes = myStakes.filter(s => s.status === 'active');
    const principalSum = activeStakes.reduce((sum, s) => sum + Number(s.outstandingPrincipal ?? s.principal ?? 0), 0);
    const earnedSum = myStakes.reduce((sum, s) => sum + Number(s.interestEarned || 0), 0);
    const runRateDaily = activeStakes.reduce((sum, s) => {
      return sum + (Number(s.principal || 0) * Number(s.dailyRateBps || 0) / 10000);
    }, 0);

    const planCards = stakePlans.map(p => stakeCardHtml(p, true)).join('');

    const myRows = myStakes.map(s => {
      const pct = s.progressPct != null ? Math.min(100, Number(s.progressPct)) : 0;
      const planClass = s.planId || 'current';
      const periodLabel = s.flexible ? '随进随出' : (s.days || 0) + ' 天到期';
      const earnedText = fmtA(s.interestEarned) + ' AIX';
      const remainText = s.status === 'active'
        ? (s.flexible ? '活期存续中' : timeLeft(Number(s.expiresAt) - Date.now()))
        : '已完成';
      return `<div class="stake-record-card ${planClass}">
        <div class="stake-record-head">
          <span class="stake-tag ${planClass}">${escapeHtml(s.label || s.planId)}</span>
          <span class="stake-record-period">${s.flexible ? '活期 · ' : '固定档 · '}${periodLabel}</span>
          <span class="status-chip ${s.status}">${s.status === 'active' ? '运行中' : '已完成'}</span>
        </div>
        <div class="stake-record-meta">
          <div class="stake-record-item"><span>质押 AIX</span><b>${fmtA(s.principal)} AIX</b></div>
          <div class="stake-record-item"><span>日利率</span><b>${(Number(s.dailyRateBps) / 100).toFixed(2)}%</b></div>
          <div class="stake-record-item"><span>已到账收益</span><b class="portal-positive">${earnedText}</b></div>
          <div class="stake-record-item"><span>已返还 AIX</span><b>${fmtA(s.principalReturned)} AIX</b></div>
          <div class="stake-record-item"><span>在押 AIX</span><b>${fmtA(s.outstandingPrincipal)} AIX</b></div>
          <div class="stake-record-item"><span>剩余</span><b>${remainText}</b></div>
        </div>
        ${pct > 0 ? `<div class="stake-record-progress"><div class="stake-record-progress-bar"><div class="stake-record-progress-fill" style="width:${pct}%"></div></div><small>${pct.toFixed(1)}%</small></div>` : ''}
        ${s.flexible && s.status === 'active' ? `<div class="stake-record-action"><button class="portal-button" onclick="window.earnUnstake('${escapeHtml(s.id)}')">赎回</button></div>` : ''}
      </div>`;
    }).join('') || `<div class="ev2-empty"><div class="big-emoji">📦</div>暂无质押记录，去下方套餐区选择合适的质押档</div>`;

    return `
      <div class="portal-metrics" style="margin-bottom:16px;border-radius:14px;overflow:hidden">
        ${P.metric('在押 AIX', fmtA(principalSum) + ' AIX')}
        ${P.metric('累计收益', fmtA(earnedSum) + ' AIX')}
        ${P.metric('运行中质押', activeStakes.length + ' 笔')}
        ${P.metric('今日收益', fmtA(runRateDaily) + ' AIX')}
      </div>

      <div class="portal-section" style="border-radius:14px;overflow:hidden;margin-bottom:20px">
        <div class="portal-section-head">
          <h2>📦 选择质押周期</h2>
          <span>档位越高 · 月化越高 · 每日自动结算</span>
        </div>
        <div class="stake-v2-grid" style="padding:16px">${planCards}</div>
      </div>

      <div class="portal-section" style="border-radius:14px;overflow:hidden">
        <p style="padding:12px 16px;color:#8fa5c0;font-size:12px;line-height:1.6">累计收益只统计已到账收益，返还的 AIX 单独展示；团队分润仅按收益计算。</p>
        <div class="portal-section-head"><h2>📊 我的质押记录</h2><span>${myStakes.length} 条记录</span></div>
        <div class="stake-record-list" style="padding:16px;display:flex;flex-direction:column;gap:12px">${myRows}</div>
      </div>`;
  }

  // ── 团队 v2 ──
  function renderTeam() {
        const team = profileCache?.teamLevel;
        const userId = profileCache?.userId || '';
        const lvlColor = team?.level >= 9 ? '#f26c78' : team?.level >= 7 ? '#f6c454' : team?.level >= 4 ? '#50d2c2' : '#81918e';
        const byKind = team?.byKind || {};
        const directs = team?.directs || [];
        const teamAmount = value => `${fmtA(value || 0)} AIX`;
        const directRows = directs.slice(0, 20).map(d => {
          const dc = d.level >= 9 ? '#f26c78' : d.level >= 7 ? '#f6c454' : d.level >= 4 ? '#50d2c2' : '#81918e';
          return `<tr>
            <td data-label="钱包地址"><code title="${escapeHtml(d.wallet)}">${escapeHtml(d.shortAddress)}</code></td>
            <td data-label="等级" style="color:${dc};font-weight:700">${d.level > 0 ? 'A' + d.level : '未达标'}</td>
            <td data-label="激活矿机数" style="color:${d.minerCount > 0 ? '#50d2c2' : '#6b7a77'};font-weight:${d.minerCount > 0 ? 700 : 400}">${d.minerCount || 0} 台</td>
            <td data-label="持有 AIX">${fmtA(d.personalA)} AIX</td>
            <td data-label="直推人数" style="color:${d.directCount > 0 ? '#50d2c2' : '#6b7a77'};font-weight:${d.directCount > 0 ? 700 : 400}">${d.directCount || 0} 人</td>
            <td data-label="团队业绩" style="color:#50d2c2;font-weight:500">${fmtA(d.teamA)} AIX</td>
            <td data-label="加入时间" style="color:#6b7a77">${d.joinedAt ? new Date(d.joinedAt).toLocaleDateString() : '—'}</td>
          </tr>`;
        }).join('');

        return `
          <div class="team-hero">
            <h2>👥 团队推荐 · 分润生态</h2>
            <p>直推 15% · 间推 10% · A1–A9 级差 / 平级奖励 · A10 均分手续费分红池</p>
          </div>

          <div class="portal-metrics" style="margin-bottom:22px;border-radius:14px;overflow:hidden">
            ${P.metric('我的团队级别', team?.level > 0 ? `<b style="font-size:22px;color:${lvlColor}">${team.levelLabel || 'A' + team.level}</b>` : '未达标')}
            ${P.metric('直推用户数', team ? (team.directCount || 0) + ' 人' : '—')}
            ${P.metric('间推用户数', team ? (team.indirectCount || 0) + ' 人' : '—')}
            ${P.metric('团队总人数', team ? (team.teamCount || 0) + ' 人' : '—')}
            ${P.metric('团队激活矿机', team ? (team.teamMinerUsers || 0) + ' 人' : '—', `Mini ${team?.teamMini || 0} 人 · Pro ${team?.teamPro || 0} 人`)}
            ${P.metric('直推激活矿机', team ? (team.directMinerUsers || 0) + ' 人' : '—', `Mini ${team?.directMini || 0} 人 · Pro ${team?.directPro || 0} 人`)}
            ${P.metric('团队收益总计', teamAmount(team?.totalEarnedA))}
            ${P.metric('团队持币总量', teamAmount(team?.teamHoldA), `直推 ${fmtA(team?.directHoldA || 0)} AIX · 团队 ${team?.teamHoldUsers || 0} 人持有`)}
            ${P.metric('团队质押业绩', teamAmount(team?.teamStakeA), `直推 ${fmtA(team?.directStakeA || 0)} AIX · 团队 ${team?.teamStakeUsers || 0} 人质押中`)}
          </div>

          <div class="portal-card" style="margin-bottom:18px;padding:18px 20px;border-radius:14px;background:rgba(18,38,36,.6)">
            <h4 style="margin:0 0 14px;color:#50d2c2">💰 分润收益明细（矿机产出 / 质押收益）</h4>
            <div class="portal-metrics" style="border-radius:10px;overflow:hidden">
              ${P.metric('直推·矿机(15%)', teamAmount(byKind.miner_direct))}
              ${P.metric('直推·质押(15%)', teamAmount(byKind.stake_direct))}
              ${P.metric('团队奖·矿机', teamAmount(byKind.miner_team))}
              ${P.metric('团队奖·质押', teamAmount(byKind.stake_team))}
              ${P.metric('间推·矿机(10%)', teamAmount(byKind.miner_indirect))}
              ${P.metric('间推·质押(10%)', teamAmount(byKind.stake_indirect))}
              ${P.metric('级差·矿机', teamAmount(byKind.miner_level_diff))}
              ${P.metric('级差·质押', teamAmount(byKind.stake_level_diff))}
              ${P.metric('平级奖(10%)', teamAmount((parseFloat(byKind.parity) || 0) + (parseFloat(byKind.miner_parity) || 0) + (parseFloat(byKind.stake_parity) || 0)))}
              ${Number(byKind.direct_count) > 0 ? P.metric('历史直推阶梯奖', teamAmount(byKind.direct_count)) : ''}
              ${team?.level === 10 || Number(byKind.a10_pool_share) > 0 ? P.metric('A10 分红池收益', teamAmount(byKind.a10_pool_share)) : ''}
            </div>
          </div>

          ${directs.length > 0 ? `
          <div class="portal-card" style="margin-bottom:18px;padding:18px 20px;border-radius:14px;background:rgba(18,38,36,.6);overflow-x:auto">
            <h4 style="margin:0 0 14px;color:#50d2c2">👥 直推团队（${directs.length} 人）</h4>
            <table class="portal-table" style="width:100%;border-collapse:collapse;font-size:13px">
              <thead><tr style="text-align:left;color:#6b7a77;border-bottom:1px solid rgba(80,210,194,.2)">
                <th style="padding:8px">钱包地址</th><th style="padding:8px">等级</th><th style="padding:8px">激活矿机数</th><th style="padding:8px">持有 AIX</th><th style="padding:8px">直推人数</th><th style="padding:8px">团队业绩</th><th style="padding:8px">加入时间</th>
              </tr></thead>
              <tbody>${directRows || `<tr><td colspan="7" style="padding:12px;text-align:center;color:#6b7a77">暂无直推用户</td></tr>`}</tbody>
            </table>
          </div>` : ''}

          ${team?.level === 10 ? `
          <div class="portal-card" style="margin-bottom:18px;padding:14px 20px;border-radius:14px;background:linear-gradient(135deg,rgba(242,108,120,.15),rgba(246,196,84,.1));border:1px solid rgba(242,108,120,.3)">
            <h4 style="margin:0 0 6px;color:#f26c78">👑 A10 专属 · 交易手续费分红池</h4>
            <p style="margin:0;color:#9ba8a5;font-size:13px">当前池累积 <b style="color:#f6c454">${fmtA(team.a10PoolAccum || 0)} AIX</b> · A10 用户 ${team.a10ParticipantCount || 0} 人 · 每天 00:00 均分到账</p>
          </div>` : ''}

          <div class="portal-card" style="margin-bottom:18px;padding:18px 20px;border-radius:14px;background:rgba(18,38,36,.6)">
            <h4 style="margin:0 0 14px;color:#50d2c2">📊 A1 ~ A10 晋级表</h4>
            <table class="portal-table" style="width:100%;border-collapse:collapse;font-size:12px">
              <thead><tr style="text-align:left;color:#6b7a77;border-bottom:1px solid rgba(80,210,194,.2)">
                <th style="padding:6px">级别</th><th style="padding:6px">个人持有</th><th style="padding:6px">团队持币 AIX</th><th style="padding:6px">收益比例</th>
              </tr></thead>
              <tbody>
                ${(team?.TEAM_LEVELS || []).map(t => {
                  const c = t.level >= 9 ? '#f26c78' : t.level >= 7 ? '#f6c454' : t.level >= 4 ? '#50d2c2' : '#81918e';
                  const mine = team?.level === t.level ? 'background:rgba(80,210,194,.12)' : '';
                  return `<tr style="${mine}">
                    <td data-label="级别" style="padding:6px;color:${c};font-weight:700">${t.label.split(' ')[0]}</td>
                    <td data-label="个人持有" style="padding:6px;color:#9ba8a5">${t.personalHeld.toLocaleString()} AIX</td>
                    <td data-label="团队持币 AIX" style="padding:6px;color:#9ba8a5">${t.teamHeld.toLocaleString()} AIX</td>
                    <td data-label="收益比例" style="padding:6px;color:${c}">${t.level === 10 ? '手续费分红' : (t.rateBps / 100) + '%'}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
            ${team?.level > 0 && team?.level < 10 && team?.nextLevel ? `<p style="margin:12px 0 0;color:#6b7a77;font-size:12px">距离下一级 ${team.nextLevel.label?.split(' ')[0] || ''}：需个人持有 ${team.nextLevel.personalHeld?.toLocaleString() || ''} AIX + 团队持币 AIX ${team.nextLevel.teamHeld?.toLocaleString() || ''} AIX</p>` : ''}
          </div>

          <div class="invite-card">
            <div>
              <h4>我的邀请码 · 好友通过链接或输入邀请码即可绑定推荐关系</h4>
              <div class="uid">${refProfileCache?.code ? escapeHtml(refProfileCache.code) : '— 尚未开通 —'}</div>
              ${refProfileCache?.code ? `<div style="margin-top:6px;font-size:11px;color:#81918e;word-break:break-all">${escapeHtml(earnRefLink())}</div>` : ''}
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn-copy" onclick="window.earnCopyCode()"${!refProfileCache?.code ? ' disabled style="opacity:.45;cursor:not-allowed"' : ''}>📋 复制邀请码</button>
              <button class="btn-copy" onclick="window.earnCopyLink()"${!refProfileCache?.code ? ' disabled style="opacity:.45;cursor:not-allowed"' : ''} style="background:rgba(80,210,194,.14);border-color:rgba(80,210,194,.35)">🔗 复制邀请链接</button>
            </div>
          </div>`;
      }

  // ── 全局交互 ──
  window.earnSwitch = (tab) => {
    currentSubTab = tab;
    document.querySelectorAll('.earn-sub-tab').forEach(b => b.classList.remove('active'));
    document.querySelector(`.earn-sub-tab[onclick="window.earnSwitch('${tab}')"]`)?.classList.add('active');
    if (tab === 'team') load();
    else if (profileCache) renderSubTab();
    else load();
  };

  let observedWallet = '';
  // 状态变化立即重绘，并使旧请求失效；完整 API 刷新由 wallet.js 触发。
  window.addEventListener('walletstatechange', event => {
    ++loadSeq;
    const wallet = String(event.detail?.address || '').toLowerCase();
    if (wallet !== observedWallet || !event.detail?.authenticated) {
      profileCache = null;
      refProfileCache = null;
    }
    observedWallet = wallet;
    if (plansCache && document.getElementById('tab-earn')?.classList.contains('active')) renderSubTab();
  });

  // 邀请链接：与「推荐」页一致的 /?ref=<推荐码>
  function earnRefLink() {
    const code = refProfileCache?.code || '';
    const link = refProfileCache?.link || `/?ref=${code}`;
    return `${location.origin}${link}`;
  }

  window.earnCopyCode = async () => {
    const code = refProfileCache?.code;
    if (!code) { showErr('暂无邀请码，请先连接钱包'); return; }
    const ok = await window.copyTextSmart?.(code);
    if (ok) showOk('邀请码已复制 · ' + code);
    else { await promptDialog('请长按邀请码全选复制', code); }
  };

  window.earnCopyLink = async () => {
    const link = earnRefLink();
    if (!refProfileCache?.code) { showErr('暂无邀请链接，请先连接钱包'); return; }
    const ok = await window.copyTextSmart?.(link);
    if (ok) showOk('邀请链接已复制');
    else { await promptDialog('请长按链接全选复制', link); }
  };

  // 兼容旧按钮命名
  window.earnCopyId = window.earnCopyCode;

  function friendlyError(e, fallback) {
    if (Number(e?.code) === 4001 || /denied|rejected|cancel/i.test(e?.message || '')) return '已取消';
    return e?.message === 'SESSION_REQUIRED' ? '请先连接并确认钱包' : (e?.message || fallback || '操作失败');
  }
  function showOk(msg) { if (typeof showToast === 'function') showToast(msg, 'ok'); else alert(msg); }
  function showErr(msg) { if (typeof showToast === 'function') showToast(msg, 'error'); else alert(msg); }

  function closeStakeModal() {
    const modal = document.getElementById('earn-stake-modal');
    if (modal) modal.remove();
    document.body.classList.remove('stake-modal-open');
  }

  function normalizeStakeAmount(raw) {
    const value = String(raw ?? '').trim().replace(/,/g, '');
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
    const [whole = '0', fraction = ''] = value.split('.');
    if (fraction.length > 18) return null;
    const normalizedWhole = whole.replace(/^0+(?=\d)/, '') || '0';
    const normalized = fraction ? `${normalizedWhole}.${fraction}` : normalizedWhole;
    return Number(normalized) > 0 ? normalized : null;
  }

  function openStakeModal(planId) {
    const minMap = { current: '100', s30: '1000', s60: '2000', s90: '5000' };
    const labelMap = { current: '活期', s30: '1号 · 30天', s60: '2号 · 60天', s90: '3号 · 90天' };
    const min = minMap[planId] || '100';
    const label = labelMap[planId] || planId;
    closeStakeModal();

    const rawBalance = Number(profileCache?.balances?.A || 0);
    const locked = Number(profileCache?.locked?.a || 0);
    const availBalance = Math.max(0, rawBalance - locked);
    const balanceText = fmtA(availBalance);

    const modal = document.createElement('div');
    modal.id = 'earn-stake-modal';
    modal.className = 'stake-modal';
    modal.setAttribute('role', 'presentation');
    modal.innerHTML = `
      <div class="stake-dialog" role="dialog" aria-modal="true" aria-labelledby="stake-modal-title">
        <div class="stake-dialog-head">
          <div><span class="stake-dialog-kicker">AIX 质押</span><h3 id="stake-modal-title">${escapeHtml(label)}</h3></div>
          <button type="button" class="stake-dialog-close" data-stake-close aria-label="关闭">×</button>
        </div>
        <div class="stake-dialog-body">
          <div class="stake-plan-summary"><span>最低质押</span><strong>${min} AIX</strong><small>输入数量后开始产生收益</small></div>
          <label class="stake-amount-label" for="stake-amount-input">质押数量</label>
          <div class="stake-amount-field"><input id="stake-amount-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${min}" aria-describedby="stake-amount-hint"><button type="button" class="stake-max-btn" data-stake-max title="质押全部可用余额">Max</button></div>
          <div id="stake-amount-hint" class="stake-amount-hint">支持最多 18 位小数 · 最小 ${min} AIX</div>
          <div class="stake-balance-line">可用余额 <b>${balanceText} AIX</b></div>
          <div id="stake-amount-error" class="stake-amount-error" role="alert" aria-live="polite"></div>
          <div class="stake-quick-amounts" aria-label="快捷数量">
            <button type="button" data-stake-quick="${min}">${min} AIX</button>
            <button type="button" data-stake-quick="${Number(min) * 2}">${Number(min) * 2} AIX</button>
            <button type="button" data-stake-quick="${Number(min) * 5}">${Number(min) * 5} AIX</button>
          </div>
        </div>
        <div class="stake-dialog-actions"><button type="button" class="stake-cancel" data-stake-close>取消</button><button type="button" class="stake-confirm" data-stake-submit>确认质押</button></div>
      </div>`;
    document.body.appendChild(modal);
    document.body.classList.add('stake-modal-open');

    const input = modal.querySelector('#stake-amount-input');
    const error = modal.querySelector('#stake-amount-error');
    const submit = modal.querySelector('[data-stake-submit]');
    const setError = message => { error.textContent = message || ''; input.classList.toggle('invalid', Boolean(message)); };
    const fillMax = () => {
      if (availBalance <= 0) { setError('可用余额不足'); return; }
      const maxStr = availBalance.toLocaleString('en-US', { maximumFractionDigits: 18, useGrouping: false });
      input.value = maxStr;
      input.focus();
      setError('');
    };
    const validate = () => {
      const amount = normalizeStakeAmount(input.value);
      if (!amount) { setError('请输入有效的 AIX 数量'); return null; }
      if (Number(amount) < Number(min)) { setError(`最低质押 ${min} AIX`); return null; }
      if (Number(amount) > availBalance) { setError(`余额不足，可用 ${balanceText} AIX`); return null; }
      setError('');
      return amount;
    };
    modal.querySelectorAll('[data-stake-close]').forEach(button => button.addEventListener('click', closeStakeModal));
    modal.addEventListener('click', event => { if (event.target === modal) closeStakeModal(); });
    modal.querySelectorAll('[data-stake-quick]').forEach(button => button.addEventListener('click', () => { input.value = button.dataset.stakeQuick; input.focus(); setError(''); }));
    modal.querySelector('[data-stake-max]').addEventListener('click', fillMax);
    input.addEventListener('input', () => setError(''));
    input.addEventListener('keydown', event => { if (event.key === 'Enter') submit.click(); if (event.key === 'Escape') closeStakeModal(); });
    submit.addEventListener('click', async () => {
      const amount = validate();
      if (!amount) { input.focus(); return; }
      submit.disabled = true;
      submit.textContent = '提交中…';
      try { await earnDoStake(planId, amount); }
      finally { if (document.body.contains(modal)) { submit.disabled = false; submit.textContent = '确认质押'; } }
    });
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }

  window.earnStake = (planId) => openStakeModal(planId);

  function formatUnits18(uStr) {
    if (!uStr) return '0';
    const s = String(uStr).replace(/^-/, '').padStart(19, '0');
    const intPart = s.slice(0, s.length - 18) || '0';
    const decPart = s.slice(s.length - 18).replace(/0+$/, '');
    const combined = intPart + (decPart ? '.' + decPart.slice(0, 4) : '');
    return fmtA(combined);
  }

  async function earnDoStake(planId, amount) {
    try {
      const r = await authApi('stake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId, principal: amount }) });
      const label = ({ current: '活期', s30: '1号 30天', s60: '2号 60天', s90: '3号 90天' })[planId] || planId;
      const displayA = r?.stake?.principalUnits ? formatUnits18(r.stake.principalUnits) : fmtA(amount);
      showOk(`质押成功 · ${label} ${displayA} AIX，开始产生收益`);
      closeStakeModal();
      profileCache = await authApi('profile').catch(() => profileCache);
      renderSubTab();
    } catch (e) { showErr(friendlyError(e, '质押失败')); }
  }
  window.earnDoStake = earnDoStake;

  window.earnUnstake = async (stakeId) => {
    if (!await confirmDialog('确认赎回该活期质押？质押的 AIX 将返还到余额')) return;
    try {
      const r = await authApi('unstake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stakeId }) });
      const principalA = r?.stake?.principalUnits ? formatUnits18(r.stake.principalUnits) : '';
      showOk(principalA ? `赎回成功，${principalA} AIX 已返回余额` : '赎回成功');
      profileCache = await authApi('profile').catch(() => profileCache);
      renderSubTab();
    } catch (e) { showErr(friendlyError(e, '赎回失败')); }
  };

  // 激活提交成功后立即本地把 activation 合并进 profileCache.activations，
  // 防止紧随其后的 profile 刷新失败时（网络抖动/session 过期）按钮回到"立即激活"，
  // 导致用户误以为没激活而重复支付 BNB（后端虽会拒绝重复激活，但链上 BNB 已付出无法退回）。
  function applyActivationLocally(planKey, status, activation) {
    if (!profileCache) profileCache = {};
    if (!Array.isArray(profileCache.activations)) profileCache.activations = [];
    const list = profileCache.activations;
    const idx = list.findIndex(a => String(a.plan) === String(planKey));
    const entry = { ...(activation || {}), plan: planKey, status };
    if (idx >= 0) list[idx] = { ...list[idx], ...entry };
    else list.unshift(entry);
  }

  // 激活提交兜底：链上付款完成后若站内提交失败（网络抖动/会话过期），
  // 把 {wallet, plan, txHash} 存 localStorage，下次进站自动补交，避免"扣了BNB没矿机"的漏单。
  const ACT_RETRY_KEY = 'axix_activation_retry_v1';
  const ACT_RETRY_MAX_TRIES = 5;
  function saveActivationRetry(wallet, planKey, txHash, tries = 0) {
    try { localStorage.setItem(ACT_RETRY_KEY, JSON.stringify({ wallet, plan: planKey, txHash, tries, at: Date.now() })); } catch {}
  }
  function readActivationRetry() {
    try { return JSON.parse(localStorage.getItem(ACT_RETRY_KEY) || 'null'); } catch { return null; }
  }
  function clearActivationRetry() { try { localStorage.removeItem(ACT_RETRY_KEY); } catch {} }

  // 下次进站自动补交：仅当当前登录钱包与存单一致；服务端已受理/已激活视为完成并清除；最多补交 5 次。
  async function retryPendingActivation() {
    const r = readActivationRetry();
    if (!r || !r.txHash) return;
    if (Date.now() - (r.at || 0) > 7 * 864e5) { clearActivationRetry(); return; }
    const cur = window.currentWalletConnection?.address
      || (typeof connectedWalletAddress !== 'undefined' ? connectedWalletAddress : '');
    if (!cur || String(cur).toLowerCase() !== String(r.wallet).toLowerCase()) return; // 换了钱包登录：不补交，等原钱包
    if ((r.tries || 0) >= ACT_RETRY_MAX_TRIES) return;
    try {
      saveActivationRetry(r.wallet, r.plan, r.txHash, (r.tries || 0) + 1);
      const result = await authApi('activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: r.plan, txHash: r.txHash }) });
      clearActivationRetry();
      showOk('检测到上次支付后提交未完成，已自动补交，链上确认后将自动发放矿机');
      applyActivationLocally(r.plan, result.activation?.status || 'pending', result.activation);
      pollActivationStatus();
      profileCache = await authApi('profile').catch(() => profileCache);
      renderSubTab();
    } catch (e) {
      // 已提交/已激活等"实质完成"的服务端错误：清除存单；其余错误保留，下次进站再试
      if (/已提交|已激活|仅可激活一次/.test(e?.message || '')) clearActivationRetry();
    }
  }

  window.earnActivate = async (planKey) => {
    const paymentWallet = window.currentWalletConnection?.address?.toLowerCase();
    const paymentProvider = typeof connectedProvider !== 'undefined' ? connectedProvider : null;
    const requirePaymentWallet = () => {
      if (!paymentWallet || paymentWallet !== window.currentWalletConnection?.address?.toLowerCase()
        || (typeof connectedProvider !== 'undefined' && paymentProvider !== connectedProvider)) {
        throw new Error('钱包账户已切换，请重新验证');
      }
    };
    // Cached/fallback cards are for browsing. Always use fresh configuration and ownership data before payment.
    try {
      plansCache = await fetchPlansFresh();
      requirePaymentWallet();
      writePlansCache(plansCache);
    } catch (error) { showErr(error.message); return; }
    const plan = (plansCache?.activation || []).find(p => p.plan === planKey);
    if (!plan) return;
    // 开关关闭时直接拦截，不触发链上转账
    if (plansCache?.activationEnabled === false) { showErr('矿机激活暂未开放，请留意平台公告'); return; }
    // 付款前二次防护：每个钱包每个套餐仅可激活一次。先刷新最新激活状态，
    // 已激活/确认中直接拦截，避免用户链上重复支付 BNB 后才被后端驳回。
    try { profileCache = await authApi('profile'); requirePaymentWallet(); }
    catch (error) { showErr(error.message); return; }
    const existingAct = (profileCache?.activations || []).find(a => String(a.plan) === String(planKey) && a.status !== 'rejected');
    if (existingAct) {
      showErr(existingAct.status === 'confirmed' ? '该套餐您已激活，每个钱包仅限激活一次' : '该套餐正在链上确认中，无需重复支付');
      renderSubTab();
      return;
    }
    const collectionAddress = (plansCache?.collectionAddressByPlan && plansCache.collectionAddressByPlan[plan.plan]) || plansCache?.collectionAddress || '';
    const chainId = plansCache?.chainId || 56;
    function bnbToWei(bnbStr) {
      const s = String(bnbStr || '0').trim();
      const [intPart = '0', decPart = ''] = s.split('.');
      const decimals = decPart.padEnd(18, '0').slice(0, 18);
      const combined = (intPart + decimals).replace(/^0+(?=.)/, '') || '0';
      return BigInt(combined);
    }
    const bnbWei = bnbToWei(plan.bnb);
    if (bnbWei <= 0n) { showErr('套餐金额无效'); return; }

    function friendlyError2(e) {
      if (Number(e?.code) === 4001 || /denied|rejected|cancel/i.test(e?.message || '')) return '已取消';
      return e?.message === 'SESSION_REQUIRED' ? '请先连接并确认钱包' : (e?.message || '激活失败');
    }

    if (!collectionAddress) {
      const txHash = await promptDialog(`请输入您已发送 ${plan.bnb} BNB 至平台收款地址后的 BSC 链交易哈希（txHash）：`, '');
      if (!txHash) return;
      const manualWallet = window.currentWalletConnection?.address
        || (typeof connectedWalletAddress !== 'undefined' ? connectedWalletAddress : '');
      if (manualWallet) saveActivationRetry(manualWallet, planKey, txHash); // 兜底落盘
      try {
        const result = await authApi('activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: planKey, txHash }) });
        clearActivationRetry();
        const status = result.activation?.status || 'pending';
        const reason = result.activation?.reason || '';
        if (status === 'confirmed') {
          showOk('激活成功，矿机已发放');
        } else {
          showOk(`已提交，${reason || '链上确认中'}，确认后将自动发放矿机`);
          pollActivationStatus();
        }
        applyActivationLocally(planKey, status, result.activation);
        profileCache = await authApi('profile').catch(() => profileCache);
        renderSubTab();
      } catch (e) {
        const pending = readActivationRetry();
        showErr(friendlyError2(e) + (pending ? '；该笔交易将被自动补交，无需重复转账' : ''));
      }
      return;
    }

    // wallet.js keeps these as top-level lexical bindings rather than
    // `window` properties. Reading only `window.connectedWalletAddress` made
    // an already-connected wallet look disconnected on the activation page.
    const activeWalletAddress = window.currentWalletConnection?.address
      || (typeof connectedWalletAddress !== 'undefined' ? connectedWalletAddress : '');
    const activeProvider = typeof connectedProvider !== 'undefined' ? connectedProvider : null;
    if (!activeWalletAddress || !activeProvider) {
      showErr('请先连接钱包');
      return;
    }
    try {
      // Make sure the platform session is ready before asking the wallet to
      // send BNB. Otherwise a first-time user could approve the payment and
      // only then be stopped by the session check in authApi().
      if (!window.currentWalletProfile?.authenticated && typeof ensurePlatformSession === 'function') {
        await ensurePlatformSession();
      }
      requirePaymentWallet();
      showOk('请在钱包中切换到 BSC 链并确认 BNB 支付');
      await activeProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + Number(chainId).toString(16) }] }).catch(async (e) => {
        if (e.code === 4902) {
          await activeProvider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x' + Number(chainId).toString(16), chainName: 'BNB Smart Chain', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: ['https://bsc-dataseed.binance.org'], blockExplorerUrls: ['https://bscscan.com'] }] });
        } else throw e;
      });
      requirePaymentWallet();
      const txHash = await activeProvider.request({ method: 'eth_sendTransaction', params: [{ from: activeWalletAddress, to: collectionAddress, value: '0x' + bnbWei.toString(16) }] });
      // 钱已付出：先落兜底存单，提交失败下次进站自动补交
      saveActivationRetry(activeWalletAddress, planKey, txHash);
      const result = await authApi('activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: planKey, txHash }) });
      clearActivationRetry();
      const status = result.activation?.status || 'pending';
      const reason = result.activation?.reason || '';
      if (status === 'confirmed') {
        showOk('激活成功，矿机已发放');
      } else {
        showOk(`支付成功，${reason || '链上确认中'}，确认后将自动发放矿机，请稍候…`);
        pollActivationStatus();
      }
      applyActivationLocally(planKey, status, result.activation);
      profileCache = await authApi('profile').catch(() => profileCache);
      renderSubTab();
    } catch (e) {
      const pending = readActivationRetry();
      showErr(friendlyError2(e) + (pending ? '；您的支付已完成，提交将自动补交，无需重复付款' : ''));
    }
  };

  // 激活提交后轮询状态:BSC 12 确认约 36 秒,每 8 秒查一次,最多 15 次(2 分钟);
  // 确认成功提示并刷新矿机列表,超时则提示稍后自动到账(服务端定时任务兜底)。
  async function pollActivationStatus() {
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 8000));
      try {
        const data = await authApi('activations');
        const mine = (data.activations || []).filter(a => a.status !== 'rejected');
        if (mine.some(a => a.status === 'confirmed')) {
          showOk('激活成功，矿机已发放');
          profileCache = await authApi('profile').catch(() => profileCache);
          renderSubTab();
          return;
        }
        if (!mine.some(a => a.status === 'pending')) return;
      } catch { return; }
    }
    showOk('链上确认仍在进行，矿机将在确认完成后自动发放，稍后刷新本页即可查看');
  }

  P.register('earn', { render, load, fail: e => { const h = document.getElementById('earn-content'); if (h) h.innerHTML = P.error(e.message, "Portal.load('earn',true)"); } });
})();
