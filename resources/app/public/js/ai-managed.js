(() => {
  const host = document.getElementById('tab-ai-managed');
  if (!host) return;

  host.innerHTML = `
    <main class="aim-page">
      <header class="aim-topbar">
        <div class="aim-heading">
          <div class="aim-title-row"><h1>AxiX 合约跟单</h1><span class="aim-status" id="aim-status">等待连接钱包</span></div>
          <p>平台内部执行与结算，收益每日到账，不自动复投</p>
        </div>
        <div class="aim-robot" role="img" aria-label="跟单机器人">
          <svg class="aim-bot" viewBox="0 0 120 100" aria-hidden="true">
            <defs>
              <linearGradient id="aimBotHead" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#23382f"/><stop offset="1" stop-color="#14211e"/>
              </linearGradient>
              <linearGradient id="aimBotBody" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#1d302b"/><stop offset="1" stop-color="#0f1917"/>
              </linearGradient>
              <radialGradient id="aimBotGlow" cx=".5" cy=".5" r=".5">
                <stop offset="0" stop-color="#4fd1b5" stop-opacity=".16"/><stop offset="1" stop-color="#4fd1b5" stop-opacity="0"/>
              </radialGradient>
            </defs>
            <ellipse class="aim-bot-halo" cx="60" cy="56" rx="46" ry="33" fill="url(#aimBotGlow)"/>
            <line x1="60" y1="7" x2="60" y2="16" stroke="#6f8e98" stroke-width="2"/>
            <circle class="aim-bot-tip" cx="60" cy="6" r="3.5" fill="#f0c84b"/>
            <rect x="21" y="29" width="7" height="15" rx="3" fill="#405b64"/>
            <rect x="92" y="29" width="7" height="15" rx="3" fill="#405b64"/>
            <rect class="aim-bot-shell" x="28" y="16" width="64" height="42" rx="11" fill="url(#aimBotHead)" stroke="#5f7e88"/>
            <rect class="aim-bot-screen" x="35" y="23" width="50" height="28" rx="6" fill="#0a1411" stroke="#4fd1b530"/>
            <rect class="aim-bot-eye" x="45" y="31" width="7" height="10" rx="3.5" fill="#4fd1b5"/>
            <rect class="aim-bot-eye" x="68" y="31" width="7" height="10" rx="3.5" fill="#4fd1b5"/>
            <path d="M55 45q5 3 10 0" fill="none" stroke="#4fd1b5" stroke-width="1.6" stroke-linecap="round" opacity=".65"/>
            <rect x="55" y="58" width="10" height="6" rx="2" fill="#405b64"/>
            <rect x="24" y="66" width="8" height="17" rx="4" fill="#2c4a42" stroke="#4a6871"/>
            <rect x="88" y="66" width="8" height="17" rx="4" fill="#2c4a42" stroke="#4a6871"/>
            <rect class="aim-bot-shell" x="33" y="64" width="54" height="29" rx="9" fill="url(#aimBotBody)" stroke="#4a6871"/>
            <rect class="aim-bot-screen" x="43" y="70" width="34" height="17" rx="4" fill="#0a1411" stroke="#4fd1b528"/>
            <line x1="51" y1="73" x2="51" y2="84" stroke="#2c4a42" stroke-width="1"/>
            <rect x="49" y="76" width="4" height="5" rx="1" fill="#4fd1b5"/>
            <line x1="60" y1="73" x2="60" y2="84" stroke="#2c4a42" stroke-width="1"/>
            <rect x="58" y="74" width="4" height="5" rx="1" fill="#f0c84b"/>
            <line x1="69" y1="73" x2="69" y2="84" stroke="#2c4a42" stroke-width="1"/>
            <rect class="aim-bot-candle" x="67" y="72" width="4" height="6" rx="1" fill="#4fd1b5"/>
            <circle class="aim-bot-dot" cx="82" cy="74" r="2.2" fill="#f0c84b"/>
          </svg>
        </div>
      </header>

      <section class="aim-metrics" aria-label="跟单资产概览">
        <div><span>跟单 USDT</span><strong id="aim-balance">0.00 USDT</strong><small>当前有效批次</small></div>
        <div><span>今日收益</span><strong class="aim-positive" id="aim-day-earned">+0.00 USDT</strong><small>达到目标后入账</small></div>
        <div><span>累计收益</span><strong class="aim-positive" id="aim-total-earned">+0.00 USDT</strong><small>历史累计</small></div>
      </section>

      <div class="aim-workspace">
        <section class="aim-panel aim-invest-panel">
          <header class="aim-panel-head"><div><h2>新增跟单</h2><p>开通 VIP 后加入跟单，停止跟单 24 小时到账</p></div><span id="aim-available">可用余额 - USDT</span></header>
          <div class="aim-vip-card" id="aim-vip-card">
            <div class="aim-vip-badge">👑 VIP</div>
            <div class="aim-vip-body">
              <b id="aim-vip-title">跟单 VIP 权益</b>
              <span id="aim-vip-desc">开通 VIP 后才能开始跟单：销毁 <b style="color:#f0c84b">100 AIX</b> 开通 <b>30 天</b>权益（永久销毁，不返还），到期后续费重新销毁 100 AIX。</span>
              <span id="aim-vip-aix" style="color:#4fd1b5;font-weight:700">AIX 余额 -</span>
            </div>
            <button class="aim-vip-btn" id="aim-vip-btn" type="button">开通 VIP · 销毁 100 AIX</button>
          </div>
          <div class="aim-amount-block">
            <label for="aim-amount">跟单金额（最低 100 USDT）</label>
            <div class="aim-amount-field"><input id="aim-amount" name="ai_managed_usdt_amount" type="number" min="100" step="0.01" inputmode="decimal" placeholder="最低 100" autocomplete="transaction-amount" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" data-bwignore="true"><span>USDT</span><button id="aim-max" type="button">全部</button></div>
          </div>
          <div class="aim-actions">
            <button class="aim-primary" id="aim-start" type="button">加入跟单</button>
            <button class="aim-secondary" id="aim-redeem" type="button" disabled>停止跟单</button>
          </div>
          <div class="aim-inline-msg" id="aim-inline-msg" hidden></div>
          <div class="aim-notice"><b>退出规则</b><span>停止跟单后进入等待退出跟单，本金 24 小时后自动返回到可用余额，不扣除任何罚金。</span></div>
        </section>

        <aside class="aim-panel aim-analysis-panel">
          <header class="aim-panel-head"><div><h2>实时合约分析</h2><p>AI 策略引擎实时推送</p></div><span id="aim-analysis-time">--:--</span></header>
          <div class="aim-analysis-content" id="aim-analysis-box">
            <div class="aim-analysis-loading">正在获取市场数据…</div>
          </div>
        </aside>
      </div>

      <section class="aim-panel aim-card-panel">
        <header class="aim-panel-head"><div><h2>跟单批次</h2><p>停止跟单后 24 小时到账</p></div><span id="aim-batch-count">0 个批次</span></header>
        <div class="aim-card-list" id="aim-batches"><div class="aim-empty">暂无跟单批次</div></div>
      </section>

      <section class="aim-panel aim-card-panel">
        <header class="aim-panel-head"><div><h2>策略执行明细</h2><p>合约跟单的周期执行记录</p></div><span id="aim-record-count">0 条记录</span></header>
        <div class="aim-card-list" id="aim-records"><div class="aim-empty">暂无执行明细</div></div>
      </section>
    </main>`;

  let state = null;
  let timer = null;
  const el = id => document.getElementById(id);
  const money = value => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:6 });
  // 收益类金额固定两位小数展示
  const earn = value => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
  function inlineMsg(type, text) {
    const box = el('aim-inline-msg');
    if (!box) return;
    box.hidden = false;
    box.className = `aim-inline-msg aim-inline-${type}`;
    box.textContent = text;
    if (type !== 'info') clearTimeout(box._timer), box._timer = setTimeout(() => { box.hidden = true; }, 5000);
  }
  function clearInline() {
    const box = el('aim-inline-msg');
    if (box) { box.hidden = true; clearTimeout(box._timer); }
  }
  const recordMoney = value => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
  const coinSize = value => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits:0, maximumFractionDigits:6 });
  const price = (value, symbol = '') => Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: symbol.startsWith('XRP') ? 4 : 2,
    maximumFractionDigits: symbol.startsWith('XRP') ? 4 : 2,
  });
  const time = value => value ? new Date(value).toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }) : '-';

  function renderBatches(items) {
    el('aim-batch-count').textContent = `${items.length} 个批次`;
    el('aim-batches').innerHTML = items.length ? items.map(item => {
      const STATUS = { active:['跟单中', 'active'], exiting:['等待退出跟单', 'pending'], exited:['已退出', 'muted'], expired:['已到期', 'complete'], redeemed:['已赎回', 'muted'] };
      const status = STATUS[item.status] || ['已结束', 'muted'];
      const exitNote = item.status === 'active' ? '可随时停止跟单'
        : item.status === 'exiting' ? `预计 ${time(item.payoutAt)} 到账`
        : '-';
      return `<div class="aim-batch-card"><div class="aim-batch-head"><code>${item.id.slice(-8).toUpperCase()}</code><span class="aim-state ${status[1]}">${status[0]}</span></div><div class="aim-kv"><span>投入 USDT</span><b>${money(item.principal)} USDT</b></div><div class="aim-kv aim-positive"><span>累计收益</span><b>+${earn(item.totalEarned)} USDT</b></div><div class="aim-kv"><span>开始时间</span>${time(item.startedAt)}</div><div class="aim-kv"><span>退出</span>${exitNote}</div></div>`;
    }).join('') : '<div class="aim-empty">暂无跟单批次</div>';
  }

  function renderRecords(items) {
    el('aim-record-count').textContent = `${items.length} 条记录`;
    el('aim-records').innerHTML = items.length ? items.map(item => {
      const isShort = item.direction === '空' || item.side === 'sell';
      const direction = isShort ? '空' : '多';
      const side = isShort ? 'sell' : 'buy';
      const profit = Number(item.profit || 0);
      const profitClass = profit >= 0 ? 'aim-positive' : 'aim-negative';
      const profitSign = profit >= 0 ? '+' : '';
      return `<div class="aim-record-card"><div class="aim-record-head"><span>${time(item.t)}</span><b>${item.symbol}</b><span class="aim-direction ${side}">${direction}</span></div><div class="aim-kv"><span>开仓价</span>${price(item.openPrice ?? item.price, item.symbol)}</div><div class="aim-kv"><span>平仓价</span>${price(item.closePrice ?? item.price, item.symbol)}</div><div class="aim-kv"><span>开仓币量</span><b title="${Number(item.size || 0).toFixed(8)}">${coinSize(item.size)}</b></div><div class="aim-kv"><span>杠杆</span>${item.leverage || 1}x</div><div class="aim-kv ${profitClass}"><span>收益</span><b title="${profitSign}${earn(item.profit)} USDT">${profitSign}${recordMoney(item.profit)} USDT</b></div></div>`;
    }).join('') : '<div class="aim-empty">暂无执行明细</div>';
  }

  function render(next) {
    state = next;
    const running = Boolean(next.running);
    const progress = Math.max(0, Math.min(1, Number(next.progress || 0)));
    el('aim-status').textContent = next.exitPending ? '等待退出跟单 · 24 小时到账' : running ? '运行中' : '未开始';
    el('aim-status').classList.toggle('running', running);
    el('aim-balance').textContent = `${money(next.principal)} USDT`;
    el('aim-day-earned').textContent = `+${earn(next.dayEarned)} USDT`;
    el('aim-total-earned').textContent = `+${earn(next.totalEarned)} USDT`;
    el('aim-available').textContent = `可用余额 ${money(next.availableBalance)} USDT`;
    const quotaEl = el('aim-quota');
    if (quotaEl) {
      const q = next.withdrawQuota;
      if (q) {
        quotaEl.style.display = '';
        quotaEl.textContent = `提现额度：可用 ${money(q.available)} USDT · 已解锁 ${money(q.unlocked)} · 已用 ${money(q.used)}（跟单本金 30 天线性解锁，每日 00:00 释放 1/30）`;
      } else {
        quotaEl.style.display = 'none';
        quotaEl.textContent = '';
      }
    }
    const vipCard = el('aim-vip-card');
    if (vipCard) {
      const expireDate = next.unlockExpiresAt ? new Date(next.unlockExpiresAt).toLocaleDateString('zh-CN') : '';
      const isVip = Boolean(next.copyTradeUnlocked);
      vipCard.classList.toggle('is-active', isVip);
      el('aim-vip-title').textContent = isVip ? 'VIP 跟单权益 · 有效中' : (next.unlockExpiresAt ? 'VIP 跟单权益 · 已到期' : '跟单 VIP 权益');
      el('aim-vip-desc').innerHTML = isVip
        ? `👑 已开通 VIP，剩余 <b style="color:#4fd1b5">${next.unlockDaysLeft ?? 0} 天</b>${expireDate ? `，有效期至 ${expireDate}` : ''}；权益期内跟单不重复销毁 AIX，到期后需续费才能继续跟单。`
        : next.unlockExpiresAt
          ? `VIP 已于 <b style="color:#f26c78">${expireDate}</b> 到期：销毁 <b style="color:#f0c84b">100 AIX</b> 续费 <b>30 天</b>（永久销毁，不返还），续费后即可继续跟单。`
          : `开通 VIP 后才能开始跟单：销毁 <b style="color:#f0c84b">100 AIX</b> 开通 <b>30 天</b>权益（永久销毁，不返还），到期后续费重新销毁 100 AIX。`;
      const vipBtn = el('aim-vip-btn');
      vipBtn.disabled = isVip || !window.currentWalletConnection?.address;
      vipBtn.textContent = isVip ? 'VIP 有效中' : (next.unlockExpiresAt ? '续费 VIP · 销毁 100 AIX' : '开通 VIP · 销毁 100 AIX');
      const aixEl = el('aim-vip-aix');
      if (aixEl) aixEl.textContent = `AIX 余额 ${recordMoney(next.aixBalance)} AIX`;
    }
    el('aim-start').disabled = false;
    el('aim-redeem').disabled = !running;
    if (next.exitPending && next.exitPayoutAt) {
      el('aim-redeem').textContent = '等待退出跟单';
    } else {
      el('aim-redeem').textContent = '停止跟单';
    }
    el('aim-amount').disabled = false;
    el('aim-max').disabled = false;
    renderBatches(next.batches || []);
    renderRecords(next.records || []);
  }

  // ── 实时合约分析 ──
  const ANALYSIS_SYMBOLS = [
    { symbol:'BTCUSDT', name:'BTC/USDT', coin:'BTC' },
    { symbol:'ETHUSDT', name:'ETH/USDT', coin:'ETH' },
    { symbol:'SOLUSDT', name:'SOL/USDT', coin:'SOL' },
  ];
  let analysisTimer = null;

  async function fetchAnalysis() {
    if (document.hidden || !host.classList.contains('active')) return;
    try {
      const pick = ANALYSIS_SYMBOLS[Math.floor(Math.random() * ANALYSIS_SYMBOLS.length)];
      const data = await Portal.readJSON(`/api/market/candles?symbol=${pick.coin}&intervalSec=3600&product=perp`);
      if (!Portal.active('ai-managed')) return;
      const candles = Array.isArray(data?.candles) ? data.candles : [];
      if (candles.length < 14) throw new Error('数据不足');
      const closes = candles.map(c => Number(c.close || 0)).filter(v => v > 0);
      const last = closes.at(-1);
      // 简易 RSI(14)
      let gains = 0, losses = 0;
      for (let i = closes.length - 14; i < closes.length; i++) {
        if (i <= 0) continue;
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff; else losses -= diff;
      }
      const rsi = 100 - (100 / (1 + (gains / Math.max(losses, 0.001)) / 14));
      // EMA12 / EMA26
      const ema = (period) => {
        const k = 2 / (period + 1);
        let e = closes[0];
        for (let i = 1; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
        return e;
      };
      const ema12 = ema(12), ema26 = ema(26);
      const macd = ema12 - ema26;
      // 布林带
      const slice = closes.slice(-20);
      const ma = slice.reduce((a, b) => a + b, 0) / slice.length;
      const std = Math.sqrt(slice.reduce((s, v) => s + (v - ma) ** 2, 0) / slice.length);
      const upper = ma + 2 * std, lower = ma - 2 * std;
      // 方向判断
      const bullish = macd > 0 && rsi < 70 && last > ma;
      const bearish = macd < 0 && rsi > 30 && last < ma;
      const signal = bullish ? '做多' : bearish ? '做空' : '观望';
      const signalClass = bullish ? 'aim-signal-long' : bearish ? 'aim-signal-short' : 'aim-signal-neutral';
      const trend = last > ma ? '多头排列' : last < ma ? '空头排列' : '震荡整理';
      // 建议杠杆
      const leverage = bullish ? [6, 8, 10][Math.floor(Math.random() * 3)] : bearish ? [5, 7, 8][Math.floor(Math.random() * 3)] : [3, 4, 5][Math.floor(Math.random() * 3)];
      // 支撑/阻力
      const support = Math.min(...closes.slice(-10)).toFixed(2);
      const resistance = Math.max(...closes.slice(-10)).toFixed(2);

      el('aim-analysis-time').textContent = new Date().toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' });
      el('aim-analysis-box').innerHTML = `
        <div class="aim-analysis-pair">
          <img class="aim-analysis-coin" src="/assets/tokens/${pick.coin.toLowerCase()}.png?v=1" alt="${pick.coin}" onerror="this.style.display='none'">
          <div><strong>${pick.name}</strong><small>${last.toLocaleString('en-US', { maximumFractionDigits:2 })} USDT</small></div>
          <span class="aim-analysis-signal ${signalClass}">${signal}</span>
        </div>
        <div class="aim-analysis-grid">
          <div><dt>趋势</dt><dd>${trend}</dd></div>
          <div><dt>RSI(14)</dt><dd class="${rsi > 70 ? 'aim-over' : rsi < 30 ? 'aim-under' : ''}">${rsi.toFixed(1)}</dd></div>
          <div><dt>MACD</dt><dd class="${macd >= 0 ? 'aim-positive' : 'aim-negative'}">${macd >= 0 ? '+' : ''}${macd.toFixed(2)}</dd></div>
          <div><dt>布林上轨</dt><dd>${Number(upper).toFixed(2)}</dd></div>
          <div><dt>布林下轨</dt><dd>${Number(lower).toFixed(2)}</dd></div>
          <div><dt>建议杠杆</dt><dd>${leverage}x</dd></div>
          <div><dt>支撑位</dt><dd>${support}</dd></div>
          <div><dt>阻力位</dt><dd>${resistance}</dd></div>
        </div>
        <div class="aim-analysis-summary">
          ${signal === '做多' ? `RSI ${rsi.toFixed(0)} 未超买，MACD 金叉向上，布林带开口扩张，建议顺势 <b>做多</b>。` : signal === '做空' ? `RSI ${rsi.toFixed(0)} 未超卖，MACD 死叉向下，布林带开口扩张，建议顺势 <b>做空</b>。` : `RSI 中性区间，布林带收窄，建议<b>观望</b>等待突破方向。`}
        </div>`;
    } catch (e) {
      el('aim-analysis-box').innerHTML = '<div class="aim-analysis-loading">分析数据获取中…</div>';
    }
  }

  function startAnalysisTimer() {
    if (analysisTimer) { fetchAnalysis(); return; }
    fetchAnalysis();
    analysisTimer = setInterval(fetchAnalysis, 30_000);
  }

  function stopAnalysisTimer() {
    if (analysisTimer) { clearInterval(analysisTimer); analysisTimer = null; }
  }

  function reset(message = '请先连接钱包') {
    ++refreshSeq; refreshRequest = null;
    render({ running:false, principal:'0', dayEarned:'0', totalEarned:'0', availableBalance:'0', dayTarget:'0', progress:0, batches:[], records:[] });
    el('aim-status').textContent = message;
    el('aim-start').disabled = !window.currentWalletConnection?.address;
  }

  async function request(path, options) {
    if (!options?.method || options.method === 'GET') return Portal.readJSON(`/api/ai-managed/${path}`, options);
    const response = await fetch(`/api/ai-managed/${path}`, options);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '跟单请求失败');
    return payload;
  }

  async function ensureSession() {
    if (window.currentWalletProfile?.authenticated) return true;
    if (!window.currentWalletConnection?.address || typeof ensurePlatformSession !== 'function') return false;
    // 手机内置浏览器中服务端会话常过期：钱包已连接时静默重新签名建立会话
    try { await ensurePlatformSession(); } catch { return false; }
    return Boolean(window.currentWalletProfile?.authenticated);
  }

  let refreshSeq = 0, refreshRequest = null, refreshWallet = '';
  function refresh() {
    if (!Portal.active('ai-managed')) return Promise.resolve();
    const wallet = Portal.walletKey();
    if (refreshRequest && wallet === refreshWallet) return refreshRequest;
    refreshWallet = wallet;
    const promise = refreshData();
    refreshRequest = promise;
    promise.finally(() => { if (refreshRequest === promise) refreshRequest = null; }).catch(() => {});
    return promise;
  }
  async function refreshData() {
    const wallet = Portal.walletKey();
    if (!window.currentWalletProfile?.authenticated) {
      const ok = await ensureSession();
      if (wallet !== Portal.walletKey() || !Portal.active('ai-managed')) return;
      if (!ok) return reset(window.currentWalletConnection?.address ? '签名验证未完成，请重新进入或点击"加入跟单"触发验证' : '请先连接钱包');
    }
    const seq = ++refreshSeq;
    const valid = () => seq === refreshSeq && wallet === Portal.walletKey() && Portal.active('ai-managed');
    try {
      const next = await request('state');
      if (valid()) render(next);
    } catch (error) {
      if (!valid()) return;
      if (/连接钱包/.test(error.message || '') && await ensureSession()) {
        try { const next = await request('state'); if (valid()) render(next); return; }
        catch (retry) { if (valid()) reset(retry.message); return; }
      }
      if (valid()) reset(error.message);
    }
  }

  async function unlockVip(button) {
    if (!state) return;
    const isRenew = Boolean(state.unlockExpiresAt) && !state.copyTradeUnlocked;
    const confirmed = await showConfirm({
      title: isRenew ? '续费 VIP 跟单权益' : '开通 VIP 跟单权益',
      lines: [
        `销毁 <b style="color:#f26c78">100 AIX</b>，${isRenew ? '续费' : '开通'} <b>30 天</b>跟单权益（永久销毁，不返还）`,
        `VIP 有效期间可随时加入跟单，<b>不再重复销毁 AIX</b>`,
        `权益到期后，需再次销毁 100 AIX 续费才能继续跟单`,
      ],
      confirmText: isRenew ? '确认续费' : '确认开通',
      cancelText: '再想想',
      danger: true,
    });
    if (!confirmed) return;
    button.disabled = true;
    try {
      await ensurePlatformSession(button);
      render(await request('unlock', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:'{}' }));
      inlineMsg('success', isRenew ? 'VIP 续费成功，30 天权益已生效' : 'VIP 开通成功，现在可以输入金额开始跟单了');
      loadPlatformProfile?.().catch(() => {});
    } catch (error) {
      if (Number(error?.code) === 4001 || /denied|rejected|cancel/i.test(error?.message || '')) return;
      const msg = error?.message || '';
      inlineMsg('error', /[\u4e00-\u9fa5]/.test(msg) ? msg : 'VIP 开通失败，请重试');
      button.disabled = !window.currentWalletConnection?.address;
    }
  }

  async function start(button) {
    const amount = el('aim-amount').value;
    if (!(Number(amount) > 0)) return inlineMsg('error', '请输入跟单金额');
    if (!(Number(amount) >= 100)) return inlineMsg('error', '跟单金额最低 100 USDT');
    if (!state?.copyTradeUnlocked) {
      return inlineMsg('error', state?.unlockExpiresAt
        ? 'VIP 跟单权益已到期，请先点击「续费 VIP」销毁 100 AIX 续费'
        : '请先点击上方「开通 VIP」销毁 100 AIX 开通 30 天权益，开通后即可跟单');
    }
    const confirmed = await showConfirm({
      title: '确认加入跟单',
      lines: [
        `跟单金额: <b>${amount} USDT</b>`,
        `👑 VIP 权益有效中，剩余 <b>${state.unlockDaysLeft ?? 0} 天</b>，跟单不重复销毁 AIX`,
        `月化收益: <b>15%-20%</b>（随机浮动）`,
        `停止跟单后进入等待退出跟单，本金 <b style="color:#4fd1b5">24 小时</b>后全额到账，不扣罚金`,
        `收益每日随机时段到账，不自动复投`,
      ],
      confirmText: '确认加入',
      cancelText: '再想想',
    });
    if (!confirmed) return;
    button.disabled = true;
    try {
      await ensurePlatformSession(button);
      render(await request('start', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ amount }) }));
      el('aim-amount').value = '';
      inlineMsg('success', '跟单资金已加入');
      loadPlatformProfile?.().catch(() => {});
    } catch (error) {
      if (Number(error?.code) === 4001 || /denied|rejected|cancel/i.test(error?.message || '')) return;
      const msg = error?.message || '';
      inlineMsg('error', /[\u4e00-\u9fa5]/.test(msg) ? msg : '加入跟单失败，请重试');
    }
    finally { button.disabled = false; }
  }

  async function stop(button) {
    const confirmed = await showConfirm({
      title: '停止跟单确认',
      lines: [
        `所有跟单中批次将<b>进入等待退出跟单</b>，已产生收益照常结算`,
        `投入的 USDT <b style="color:#4fd1b5">全额返还</b>，不扣除任何罚金`,
        `本金将于 <b>24 小时后</b>自动返回到可用余额`,
        `此操作不可撤销`,
      ],
      confirmText: '确认停止',
      cancelText: '取消',
      danger: true,
    });
    if (!confirmed) return;
    button.disabled = true;
    try {
      await ensurePlatformSession(button);
      render(await request('stop', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:'{}' }));
      inlineMsg('success', '已提交停止跟单，本金将于 24 小时后到账');
      loadPlatformProfile?.().catch(() => {});
    } catch (error) {
      if (Number(error?.code) === 4001 || /denied|rejected|cancel/i.test(error?.message || '')) return;
      const msg = error?.message || '';
      inlineMsg('error', /[\u4e00-\u9fa5]/.test(msg) ? msg : '停止跟单失败，请重试');
    }
    finally { button.disabled = !state?.running; }
  }

  function activate() {
    startAnalysisTimer();
    refresh();
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden && host.classList.contains('active')) refresh(); }, 30_000);
  }

  el('aim-start').onclick = event => start(event.currentTarget);
  el('aim-redeem').onclick = event => stop(event.currentTarget);
  el('aim-vip-btn').onclick = event => unlockVip(event.currentTarget);
  el('aim-max').onclick = () => { if (state) el('aim-amount').value = state.availableBalance || ''; };
  function deactivate() { clearInterval(timer); timer = null; stopAnalysisTimer(); }
  window.addEventListener('pagechange', event => { if (event.detail.current !== 'ai-managed') deactivate(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) deactivate(); else if (Portal.active('ai-managed')) activate(); });
  window.AiManaged = { activate, refresh, reset, deactivate };
  if (new URLSearchParams(location.search).get('page') === 'ai-managed') setTimeout(() => switchTab('ai-managed'), 0);
})();
