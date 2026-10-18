(() => {
  const P = Portal;
  let poolStats = null;
  let profile = null;
  let currentSide = 'buy';
  let currentOrderType = 'market';       // 'market' | 'limit'
  let accountTab = 'balances';           // 底部账户面板 tab：balances/positions/orders/history/fills
  let atradePeriod = '15m';
  let atradeChart = null;
  let atradeCandleSeries = null;
  let atradeKlineTimer = null;
  let atradeChartResizeObserver = null;
  let atradeChartResizeHandler = null;
  let atradeChartViewportHandler = null;
  let atradeLastTime = 0;
  let atradeDataSeq = 0; // 请求世代号：丢弃切换周期后才返回的过期响应
  let atradeOrdersTimer = null;          // 我的委托 5s 轮询
  let atradeBookTimer = null;            // 真实 P2P 盘口 4s 轮询
  let atradeBookSeq = 0;                 // 盘口请求序号，忽略过期响应
  let bookData = { bids: [], asks: [], markPrice: null };
  let openOrdersData = { buys: [], sells: [], count: 0 };
  let atradeOpenOrdersSeq = 0;
  let myOrdersCache = [];
  // 报价请求序号：输入、买卖方向或订单类型快速切换时，忽略过期响应，
  // 避免旧报价覆盖当前表单内容。
  let quoteRequestId = 0;

  const api = async (path, options) => {
    const response = await fetch(`/api/a-token/${path}`, options);
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error('交易服务暂时不可用，请稍后重试'); }
    if (!response.ok) throw new Error(payload.error || 'AIX 代币交易请求失败');
    return payload;
  };
  const authApi = async (path, options = {}) => {
    if (!window.currentWalletProfile?.authenticated && window.currentWalletConnection?.address
      && typeof ensurePlatformSession === 'function') await ensurePlatformSession();
    if (!window.currentWalletProfile?.authenticated) throw new Error('SESSION_REQUIRED');
    return api(path, options);
  };
  const fmtA = (v) => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '0'; };
  const fmtUsdt = (v) => { const n = Number(v); return Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '$0.00'; };
  function showOk(msg) { if (typeof showToast === 'function') showToast(msg, 'ok'); else alert(msg); }
  function showErr(msg) { if (typeof showToast === 'function') showToast(msg, 'error'); else alert(msg); }
  function friendlyError(e, fallback) {
    if (Number(e?.code) === 4001 || /denied|rejected|cancel/i.test(e?.message || '')) return '已取消';
    return e?.message === 'SESSION_REQUIRED' ? '请先连接并确认钱包' : (e?.message || fallback || '交易失败');
  }
  const esc = P.esc;

  function render() {
    const root = document.getElementById('tab-a-token-trade');
    if (!root) return;
    root.innerHTML = `<div class="portal-shell">
      ${P.header('AIX 代币交易', 'AIX / 泰达币（USDT）· 买方 0 手续费 · 卖方按直推人数阶梯手续费（50%销毁 + 50%进A10分红池）')}
      <div id="atrade-content">${P.loading(6)}</div>
    </div>`;
  }

  async function load() {
    const host = document.getElementById('atrade-content');
    if (!host) return;
    const statsPromise = api('pool').catch(() => null);
    let stats = null, prof = null, authFailed = false;
    try {
      [stats, prof] = await Promise.all([statsPromise, authApi('profile')]);
    } catch (e) {
      if (e.message === 'SESSION_REQUIRED') authFailed = true;
      stats = stats || await statsPromise.catch(() => null);
    }
    if (!stats) { host.innerHTML = P.error('AIX 代币池数据加载失败', "Portal.load('a-token-trade',true)"); return; }
    poolStats = stats;
    if (prof) profile = prof;
    host.innerHTML = prof ? renderContent() : renderPoolOnly(authFailed);
    // 初始化：买卖 tab 态、滑条、K 线、委托轮询
    window.setTimeout(() => {
      window.atradeSide(currentSide);
      // 如果之前切过限价，现在 DOM 重绘后重新把 switch 切回当前 currentOrderType
      if (currentOrderType === 'limit') window.atradeOrderType('limit');
      // 真实 P2P 盘口：立即拉一次 + 4s 轮询（公开，游客可见）；挂单明细随盘口一起刷新
      window.atradeLoadBook();
      window.atradeLoadOpenOrders();
      if (atradeBookTimer) { clearInterval(atradeBookTimer); atradeBookTimer = null; }
      atradeBookTimer = setInterval(() => {
        window.atradeLoadBook().catch(() => {});
        if (document.getElementById('atrade-orders-panel')?.style.display !== 'none') {
          window.atradeLoadOpenOrders().catch(() => {});
        }
      }, 4000);
      try { window.atradeInitChart(); } catch (e) { console.error('[A Trade Chart] init fail', e); }
      // 我的委托 5s 轮询
      if (atradeOrdersTimer) { clearInterval(atradeOrdersTimer); atradeOrdersTimer = null; }
      if (prof) {
        window.atradeRefreshOrders();
        window.atradeRenderAccount();
        atradeOrdersTimer = setInterval(() => window.atradeRefreshOrders().catch(() => {}), 5000);
      }
    }, 0);
  }

  // ── 价格条 ──
  function topInfoBar() {
    const s = poolStats || {};
    const p = profile || null;
    const price = Number(s.priceUsdt || 0.1);
    const priceStr = price.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    const volA = Number(s.todayVolumeA || 0);
    const volUsdt = volA * price;
    const burned = Number(s.totalBurned || 0);
    const dividendPool = Number(s.dividendPool || 0);
    const high24h = Number(s.todayHigh || price);
    const low24h = Number(s.todayLow || price);
    const recentTrades = s.recentTrades || [];
    let changePct = 0;
    if (recentTrades.length >= 2) {
      const first = Number(recentTrades[0].priceUsdt || price);
      const last = Number(recentTrades[recentTrades.length - 1].priceUsdt || price);
      if (last > 0) changePct = (first - last) / last * 100;
    }
    const up = changePct >= 0;
    const cls = up ? 'up' : 'down';

    // 顶部余额四格（USDT/AIX/等级/UID）已移除：余额在下单面板显示，等级/UID 在赚币页显示，游客仅保留连接钱包按钮
    const balanceBar = p
      ? ''
      : `<div class="balance-bar">
          <button class="balance-cta" type="button" onclick="connectWallet(this)">🔗 连接钱包</button>
        </div>`;

    return `<div class="atrade-spot-price-strip">
      <div class="atrade-pair-name">
        <div class="pair-icon" style="overflow:hidden"><img src="/assets/tokens/a.png?v=4" alt="AIX" style="width:100%;height:100%;object-fit:cover"></div>
        <div>
          <h2>AIX / USDT <span class="change-pill" style="margin-left:8px;background:rgba(80,210,194,0.12);color:#50d2c2;border:1px solid rgba(80,210,194,0.3);font-weight:700;padding:2px 8px;border-radius:999px;font-size:10px">委托簿撮合 · 买需有卖 / 卖需有买</span></h2>
          <small>AIX 代币 / 泰达币 · BSC · 用户委托互为对手方</small>
        </div>
      </div>
      <div class="price-big">
        <div class="num ${cls}">$${priceStr}<small style="font-size:13px;color:#81918e;margin-left:8px;font-weight:500">USDT</small></div>
        <div class="sub">
          <span class="change-pill ${cls}">${up ? '+' : ''}${changePct.toFixed(2)}%</span>
          <span>24h 最高 <b style="color:#e7f1ef">$${high24h.toFixed(4)}</b></span>
          <span>24h 最低 <b style="color:#e7f1ef">$${low24h.toFixed(4)}</b></span>
        </div>
      </div>
      <div class="atrade-spot-meta">
        <div class="meta-kv"><span>今日交易量（AIX）</span><b>${fmtA(volA)} AIX</b></div>
        <div class="meta-kv"><span>今日成交额</span><b>${fmtUsdt(volUsdt)}</b></div>
        <div class="meta-kv"><span>今日销毁数量</span><b style="color:#f26c78">${fmtA(Number(s.todayBurned || 0))} AIX</b></div>
        <div class="meta-kv"><span>累计销毁 AIX</span><b style="color:#f26c78">${fmtA(burned)} AIX</b></div>
        <div class="meta-kv"><span>A10 团队分红池</span><b style="color:#f6c454">${fmtA(dividendPool)} AIX</b></div>
        <div class="meta-kv"><span>委托求购额度</span><b style="color:#50d2b8">${fmtUsdt(Number(s.depth?.openBuyUsdt || 0))}</b></div>
      </div>
      ${balanceBar}
    </div>`;
  }

  // ── 左：下单面板（v14 重做：对齐现货 order-entry，独立 .aentry 作用域样式）──
  function orderPanel() {
    const p = profile || {};
    const balUsdt = Number(p.balances?.USDT || 0);
    const balA = Number(p.balances?.A || 0);
    const price = Number(poolStats?.priceUsdt || 0.1);
    const showBalance = (side) => side === 'buy' ? fmtUsdt(balUsdt) : fmtA(balA) + ' AIX';
    const placeholder = (side) => side === 'buy' ? `最多使用 ${fmtUsdt(balUsdt)}` : `最多卖出 ${fmtA(balA)} AIX`;
    const isLimit = currentOrderType === 'limit';

    return `<aside class="aentry">
      <div class="aentry-title">下单<small>AIX / USDT · 撮合价 $${price.toFixed(4)}</small></div>
      <div class="aentry-switch">
        <button type="button" data-side="buy" class="active buy" onclick="window.atradeSide('buy')">买入 AIX</button>
        <button type="button" data-side="sell" class="sell" onclick="window.atradeSide('sell')">卖出 AIX</button>
      </div>
      <div class="aentry-type" aria-label="订单类型">
        <button type="button" data-otype="market" class="active" onclick="window.atradeOrderType('market')">市价</button>
        <button type="button" data-otype="limit" onclick="window.atradeOrderType('limit')">限价委托</button>
      </div>
      <label class="aentry-avail" title="点击填满数量"><span>可用</span><b id="atrade-balance-val" style="cursor:pointer" onclick="window.atradeSliderFill(100)">${showBalance(currentSide)}</b></label>

      <label id="atrade-input-label" class="aentry-amt-label">${currentSide === 'buy' ? '支付 USDT 数量' : '卖出 AIX 数量'}</label>
      <div class="aentry-field" id="atrade-price-field" ${isLimit ? '' : 'hidden'}>
        <span>限价</span>
        <input id="atrade-input-price" type="number" min="0" step="0.0001" autocomplete="off" inputmode="decimal" placeholder="低于现价买 · 高于现价卖" oninput="window.atradeInputChanged()">
        <b>USDT</b>
      </div>
      <div class="aentry-field">
        <span>数量</span>
        <input id="atrade-input-amount" type="number" min="0" step="any" autocomplete="off" inputmode="decimal" placeholder="${placeholder(currentSide)}" oninput="window.atradeInputChanged()">
        <b id="atrade-input-unit">${currentSide === 'buy' ? 'USDT' : 'AIX'}</b>
      </div>

      <input class="aentry-slider" id="atrade-slider" type="range" min="0" max="100" value="0" aria-label="仓位比例" oninput="window.atradeSliderChanged(this.value)">
      <div class="aentry-pcts">
        <button type="button" data-pct="0"   onclick="window.atradeSliderFill(0)">0%</button>
        <button type="button" data-pct="25"  onclick="window.atradeSliderFill(25)">25%</button>
        <button type="button" data-pct="50"  onclick="window.atradeSliderFill(50)">50%</button>
        <button type="button" data-pct="75"  onclick="window.atradeSliderFill(75)">75%</button>
        <button type="button" data-pct="100" onclick="window.atradeSliderFill(100)">100%</button>
      </div>

      <div class="aentry-quote" id="atrade-quote-box-buy"  ${currentSide === 'buy'  ? '' : 'hidden'}>${quoteBoxBuy()}</div>
      <div class="aentry-quote" id="atrade-quote-box-sell" ${currentSide === 'sell' ? '' : 'hidden'}>${quoteBoxSell()}</div>

      <button class="terminal-order-btn" id="atrade-order-btn" onclick="window.atradeSubmit()">
        ${profile ? atradeSubmitButtonLabel() : '连接钱包开始交易'}
      </button>

      <div class="aentry-sum"><span>订单价值</span><b id="atrade-summary-value">$0.00</b></div>
      <div class="aentry-sum"><span>预计手续费</span><b id="atrade-summary-fee">0 AIX</b></div>
      <div class="aentry-sum match"><span>撮合说明</span><b style="font-size:11px;font-weight:500;color:#b7c5c1">${isLimit ? '与对手方挂单撮合 · 未成转委托' : '按现价吃对手方挂单 · 未成转委托'}</b></div>
    </aside>`;
  }
  function atradeSubmitButtonLabel() {
    if (currentOrderType === 'limit') {
      return currentSide === 'buy' ? '挂限价买单' : '挂限价卖单';
    }
    return currentSide === 'buy' ? '立即买入 AIX' : '立即卖出 AIX';
  }

  function quoteBoxBuy() {
    return `<div class="q-row"><span>可获得 AIX</span><b class="gain" id="q-buy-a">—</b></div>
      <div class="q-row"><span>成交单价</span><b id="q-buy-price">—</b></div>
      <div class="q-row"><span>买方手续费</span><b style="color:#50d2b8">$0.00（免）</b></div>`;
  }
  // 卖出手续费标签：优先用登录用户 profile 里的阶梯费率档案（随直推激活人数实时更新）
  function sellFeeLabel() {
    const sf = profile?.sellFee;
    if (sf?.feePct) return `手续费 (${sf.feePct}${sf.directCount != null ? ` · 直推${sf.directCount}人` : ''} · 成交时扣)`;
    return '手续费 (按直推阶梯 · 成交时扣)';
  }
  function quoteBoxSell() {
    return `<div class="q-row"><span>净得 USDT</span><b class="gain" id="q-sell-usdt">—</b></div>
      <div class="q-row"><span id="q-sell-fee-lbl">${sellFeeLabel()}</span><b class="loss" id="q-sell-fee">—</b></div>
      <div class="q-row"><span>&nbsp;&nbsp;· 销毁 (手续费50%)</span><b style="color:#f26c78" id="q-sell-burn">—</b></div>
      <div class="q-row"><span>&nbsp;&nbsp;· A10分红池 (手续费50%)</span><b style="color:#f6c454" id="q-sell-div">—</b></div>`;
  }

  // ── 中：订单簿 / 成交 / 我的委托 tab ──
  function middlePanel() {
    const s = poolStats || {};
    const price = Number(s.priceUsdt || 0.1);
    const recentTrades = s.recentTrades || [];

    const tradeRows = recentTrades.map(t => {
      const tSide = t.side === 'buy' ? 'bid' : 'ask';
      return `<div style="display:grid;grid-template-columns:repeat(3,1fr);padding:3px 16px;font-size:12px;font-variant-numeric:tabular-nums">
        <span style="text-align:left;color:${tSide==='bid'?'#50d2b8':'#f26c78'};font-weight:600">${fmtUsdt(t.priceUsdt)}</span>
        <span style="text-align:right">${fmtA(t.size)} AIX</span>
        <span style="text-align:right;color:#81918e;font-size:11px">${new Date(t.createdAt).toLocaleTimeString('zh-CN',{hour12:false})}</span>
      </div>`;
    }).join('') || `<div class="ev2-empty" style="padding:28px 20px">暂无成交 · 等待首笔交易 🎉</div>`;

    return `<div class="book-card">
      <div class="book-head-tabs">
        <div class="tabs-mini" id="atrade-tabs-middle">
          <button type="button" class="active" data-mview="book"   onclick="window.atradeMiddleView('book')">📊 订单簿</button>
          <button type="button" data-mview="orders" onclick="window.atradeMiddleView('orders')">📋 挂单明细</button>
        </div>
      </div>

      <!-- 订单簿 -->
      <div id="atrade-book-panel">
        <div class="book-head"><span>价格</span><span>数量（AIX）</span><span>合计</span></div>
        <div class="rows-ask" id="atrade-rows-ask"></div>
        <div class="book-divider">
          <span id="atrade-book-mark">$${price.toFixed(4)}</span>
          <span></span>
          <span></span>
        </div>
        <div class="rows-bid" id="atrade-rows-bid"></div>
      </div>

      <!-- 挂单明细：逐笔 OPEN 委托 -->
      <div id="atrade-orders-panel" style="display:none">
        <div id="atrade-open-orders-body" style="max-height:420px;overflow-y:auto"></div>
      </div>

      <!-- 最近成交 -->
      <div id="atrade-trades-panel" style="display:none">
        <div class="book-head"><span>价格</span><span>数量（AIX）</span><span>时间</span></div>
        ${tradeRows}
      </div>
    </div>`;
  }

  // ── 右：账户/池数据卡片（v11 重布局：已上提到顶部 topInfoBar，rightPanel 删除）──

  // ── 底部：账户面板（登录用户）· 与现货终端一致的五 tab ──
  function accountSection() {
    const p = profile || null;
    if (!p) return '';
    const labels = { balances: '资产', positions: '持仓', orders: '当前委托', history: '历史委托', fills: '成交历史' };
    const tabs = Object.entries(labels).map(([view, label]) =>
      `<button type="button" class="${accountTab === view ? 'active' : ''}" data-aview="${view}" onclick="window.atradeAccountTab('${view}')">${label}</button>`
    ).join('');
    return `<div class="portal-section atrade-account" style="border-radius:14px;overflow:hidden;margin-top:18px">
      <div class="terminal-tabs" id="atrade-account-tabs">${tabs}</div>
      <div id="atrade-account-content" class="terminal-account-content" style="height:auto;min-height:120px;max-height:320px"></div>
    </div>`;
  }

  // ── 登录后完整渲染（v16：现货式三列布局 K线|订单簿|下单）──
  function renderContent() {
    return `${topInfoBar()}
      <div class="atrade-terminal">
        <div class="atrade-terminal-grid">
          <section class="atrade-cell atrade-cell-chart">${chartSection()}</section>
          <aside class="atrade-cell atrade-cell-book">${middlePanel()}</aside>
          <aside class="atrade-cell atrade-cell-entry">${orderPanel()}</aside>
        </div>
        ${accountSection()}
      </div>`;
  }

  // ── 游客：无账户信息，但依然能看行情 + 连钱包按钮 ──
  function renderPoolOnly(authFailed) {
    return `${topInfoBar()}
      <div class="atrade-terminal">
        <div class="atrade-terminal-grid">
          <section class="atrade-cell atrade-cell-chart">${chartSection()}</section>
          <aside class="atrade-cell atrade-cell-book">${middlePanel()}</aside>
          <aside class="atrade-cell atrade-cell-entry">${orderPanel()}</aside>
        </div>
        ${P.walletGate('连接并确认钱包后，即可使用 USDT 买入 AIX 或卖出 AIX 换回 USDT')}
      </div>`;
  }

  // ── K 线区域 ──
  function chartSection() {
    const periods = [
      { id: '1m', label: '1 分' },
      { id: '5m', label: '5 分' },
      { id: '15m', label: '15 分' },
      { id: '1h', label: '1 时' },
      { id: '4h', label: '4 时' },
      { id: '1d', label: '日' },
    ];
    const tabs = periods.map(p => `<button type="button" data-period="${p.id}" class="${atradePeriod === p.id ? 'active' : ''}" onclick="window.atradeSwitchPeriod('${p.id}')">${p.label}</button>`).join('');
    return `
      <section class="atrade-chart-card atrade-chart-section">
        <div class="atrade-chart-toolbar">
          <div class="atrade-chart-tabs">${tabs}</div>
          <span class="muted" style="font-size:11px;margin-left:auto">AIX / USDT · 实时行情</span>
        </div>
        <div id="atrade-chart" class="atrade-chart-host"></div>
      </section>
    `;
  }

  // ═══════════════════════════════════════════════════════
  //  交互
  // ═══════════════════════════════════════════════════════

  window.atradeSide = (side) => {
    quoteRequestId += 1;
    clearTimeout(quoteTimer);
    currentSide = side === 'sell' ? 'sell' : 'buy';
    // tab 样式（A 币下单面板的买卖切换是 .aentry-switch，注意别写成主终端的 .side-switch）
    document.querySelectorAll('.aentry-switch button[data-side]').forEach(b => {
      const s = b.dataset.side;
      b.classList.toggle('active', s === currentSide);
      b.classList.toggle('buy', s === 'buy');
      b.classList.toggle('sell', s === 'sell');
    });
    // quote box 显隐（用 hidden 属性，避免 inline display 破坏 display:grid 以及 margin-collapse）
    const buyBox  = document.getElementById('atrade-quote-box-buy');
    const sellBox = document.getElementById('atrade-quote-box-sell');
    if (buyBox)  buyBox.hidden  = currentSide !== 'buy';
    if (sellBox) sellBox.hidden = currentSide !== 'sell';
    // labels / units
    const p = profile || {};
    const balUsdt = Number(p.balances?.USDT || 0);
    const balA = Number(p.balances?.A || 0);
    const balVal = document.getElementById('atrade-balance-val');
    const inpLabel = document.getElementById('atrade-input-label');
    const inpUnit = document.getElementById('atrade-input-unit');
    const inp = document.getElementById('atrade-input-amount');
    const btn = document.getElementById('atrade-order-btn');
    const limitTypeBtn = document.querySelector('[data-otype="limit"]');
    if (limitTypeBtn) {
      limitTypeBtn.hidden = false;
      limitTypeBtn.setAttribute('aria-hidden', 'false');
    }
    if (balVal)   balVal.textContent   = currentSide === 'buy' ? fmtUsdt(balUsdt) : fmtA(balA) + ' AIX';
    if (inpLabel) inpLabel.textContent = currentSide === 'buy' ? '支付 USDT 数量' : '卖出 AIX 数量';
    if (inpUnit)  inpUnit.textContent  = currentSide === 'buy' ? 'USDT' : 'AIX';
    if (inp) {
      inp.placeholder = currentSide === 'buy'
        ? `最多使用 ${fmtUsdt(balUsdt)} USDT`
        : `最多卖出 ${fmtA(balA)} AIX`;
      inp.value = '';
    }
    if (btn) {
      btn.className = 'terminal-order-btn' + (currentSide === 'sell' ? ' sell' : '');
      btn.textContent = profile ? atradeSubmitButtonLabel() : '连接钱包开始交易';
    }
    const priceField = document.getElementById('atrade-price-field');
    if (priceField) priceField.hidden = currentOrderType !== 'limit';
    document.querySelectorAll('[data-otype]').forEach(b => {
      b.classList.toggle('active', b.dataset.otype === currentOrderType);
    });
    // slider 归零
    const slider = document.getElementById('atrade-slider');
    if (slider) slider.value = 0;
    // summary 清空
    const sv = document.getElementById('atrade-summary-value'); if (sv) sv.textContent = '$0.00';
    const sf = document.getElementById('atrade-summary-fee');   if (sf) sf.textContent = '0 AIX';
    // quote 清空
    const e = (id) => document.getElementById(id);
    if (currentSide === 'buy') {
      if (e('q-buy-a'))     e('q-buy-a').textContent = '—';
      if (e('q-buy-price')) e('q-buy-price').textContent = '—';
    } else {
      if (e('q-sell-usdt')) e('q-sell-usdt').textContent = '—';
      if (e('q-sell-fee'))  e('q-sell-fee').textContent  = '—';
      if (e('q-sell-burn')) e('q-sell-burn').textContent = '—';
      if (e('q-sell-div'))  e('q-sell-div').textContent  = '—';
    }
  };

  window.atradeOrderType = (type) => {
    quoteRequestId += 1;
    clearTimeout(quoteTimer);
    // 买卖双方均可挂限价单
    currentOrderType = type === 'limit' ? 'limit' : 'market';
    // tab 高亮
    document.querySelectorAll('[data-otype]').forEach(b => {
      b.classList.toggle('active', b.dataset.otype === currentOrderType);
    });
    // 显示/隐藏限价输入框（hidden 属性，保证与选择器 .aentry-field[hidden] 命中且不产生 margin 留白）
    const pf = document.getElementById('atrade-price-field');
    if (pf) pf.hidden = currentOrderType !== 'limit';
    // 按钮文字
    const btn = document.getElementById('atrade-order-btn');
    if (btn) btn.textContent = profile ? atradeSubmitButtonLabel() : '连接钱包开始交易';
    // 撮合价摘要行文案
    const m = document.getElementById('atrade-summary-match');
    const price = Number(poolStats?.priceUsdt || 0.1);
    if (m) m.textContent = `$${price.toFixed(4)}${currentOrderType === 'limit' ? '（限价触发）' : ' / AIX（即时）'}`;
    // 限价切换时，以当前 pool 现价自动预填限价 input
    if (currentOrderType === 'limit') {
      const pinp = document.getElementById('atrade-input-price');
      if (pinp && !pinp.value) {
        // 挂买单默认比现价低 0.05%，挂卖单默认高 0.05%，引导用户正确的方向
        const base = currentSide === 'buy' ? price * 0.995 : price * 1.005;
        pinp.value = Math.max(0.0001, base).toFixed(4);
      }
    }
    // 若已有输入值，重算一次报价
    const ainp = document.getElementById('atrade-input-amount');
    if (ainp && ainp.value) window.atradeInputChanged(true);
  };

  window.atradeMiddleView = (view) => {
    document.querySelectorAll('#atrade-tabs-middle button').forEach(b => {
      b.classList.toggle('active', b.dataset.mview === view);
    });
    const bp = document.getElementById('atrade-book-panel');
    const op = document.getElementById('atrade-orders-panel');
    const tp = document.getElementById('atrade-trades-panel');
    if (bp) bp.style.display = view === 'book' ? '' : 'none';
    if (op) op.style.display = view === 'orders' ? '' : 'none';
    if (tp) tp.style.display = view === 'trades' ? '' : 'none';
    if (view === 'orders') {
      window.atradeLoadOpenOrders().catch(() => {});
    }
  };

  // ── 拉取挂单明细（逐笔 OPEN 委托） ──
  window.atradeLoadOpenOrders = async () => {
    const seq = ++atradeOpenOrdersSeq;
    try {
      const data = await api('open-orders?limit=50');
      if (seq !== atradeOpenOrdersSeq) return;
      openOrdersData = data || { buys: [], sells: [], count: 0 };
      window.atradeRefreshOpenOrders();
    } catch { /* 静默：保留上一帧 */ }
  };

  // ── 渲染挂单明细：买入/卖出两段，每笔展示挂单价、数量、金额、市价/限价、时间 ──
  window.atradeRefreshOpenOrders = () => {
    const host = document.getElementById('atrade-open-orders-body');
    if (!host) return;
    const p4 = (v) => { const n = Number(v || 0); return Number.isFinite(n) ? n.toFixed(4) : '0.0000'; };
    const num = (v, d=2) => { const n = Number(v || 0); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—'; };
    const t = (ts) => new Date(Number(ts) || Date.now()).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });
    const typeTag = (type) => type === 'limit'
      ? '<span style="font-size:10px;color:#7fc7d9;border:1px solid rgba(127,199,217,.35);border-radius:4px;padding:0 4px;line-height:16px;height:16px">限价</span>'
      : '<span style="font-size:10px;color:#d9c27f;border:1px solid rgba(217,194,127,.35);border-radius:4px;padding:0 4px;line-height:16px;height:16px">市价跟随</span>';

    const renderSection = (title, rows, side, isBuy) => {
      if (!rows.length) {
        return `<div style="margin-bottom:10px"><div style="font-size:11px;color:#81918e;padding:4px 2px 6px">${title}</div>`
          + `<div style="text-align:center;color:#5f6f6c;font-size:11px;padding:14px 0">暂无${isBuy ? '买单' : '卖单'}</div></div>`;
      }
      const rowsHtml = rows.map(r => {
        const amountLabel = isBuy
          ? `<div>金额 <b style="color:#dfeae8">$${num(r.amountUsdt)}</b></div><div style="color:#81918e">可买 ${num(r.sizeA, 4)} AIX</div>`
          : `<div>数量 <b style="color:#dfeae8">${num(r.sizeA, 4)} AIX</b></div><div style="color:#81918e">净额 ${num(r.netA, 4)} · $${num(r.amountUsdt)}</div>`;
        return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:7px 4px;border-bottom:1px dashed rgba(255,255,255,.05)">`
          + `<div style="min-width:0">${amountLabel}<div style="color:#5f6f6c;font-size:10px;margin-top:2px">${t(r.createdAt)}</div></div>`
          + `<div style="text-align:right;white-space:nowrap"><div class="${side}" style="font-size:12px;font-weight:600">$${p4(r.priceUsdt)}</div><div style="margin-top:2px">${typeTag(r.orderType)}</div></div>`
          + `</div>`;
      }).join('');
      return `<div style="margin-bottom:10px"><div style="font-size:11px;color:#81918e;padding:4px 2px 6px">${title}（${rows.length}）</div>${rowsHtml}</div>`;
    };

    const sells = openOrdersData.sells || [];
    const buys = openOrdersData.buys || [];
    if (!sells.length && !buys.length) {
      host.innerHTML = '<div style="text-align:center;color:#5f6f6c;font-size:12px;padding:36px 16px;line-height:1.8">当前没有任何挂单<br><span style="font-size:11px">用户提交市价或限价委托后，会在这里逐笔显示</span></div>';
      return;
    }
    host.innerHTML = renderSection('卖盘委托', sells, 'down', false) + renderSection('买盘委托', buys, 'up', true);
  };

  // ── 拉取真实 P2P 盘口（聚合 OPEN 委托），4s 轮询 ──
  window.atradeLoadBook = async () => {
    const seq = ++atradeBookSeq;
    try {
      const data = await api('orderbook?limit=20&tick=0.0001');
      if (seq !== atradeBookSeq) return;   // 丢弃过期响应
      bookData = data || { bids: [], asks: [] };
      window.atradeRefreshBook();
    } catch { /* 静默：保留上一帧盘口 */ }
  };

  // ── 渲染订单簿（真实 OPEN 委托档位） ──
  window.atradeRefreshBook = () => {
    const askBox = document.getElementById('atrade-rows-ask');
    const bidBox = document.getElementById('atrade-rows-bid');
    if (!askBox || !bidBox) return;

    const asks = (bookData?.asks || []).slice(0, 10);   // 价低在前（最优）
    const bids = (bookData?.bids || []).slice(0, 10);   // 价高在前（最优）
    const p4 = (v) => { const n = Number(v || 0); return Number.isFinite(n) ? n.toFixed(4) : '0.0000'; };

    // 深度条按本侧最大档位归一化
    const maxAsk = Math.max(1, ...asks.map(r => Number(r.size) || 0));
    const maxBid = Math.max(1, ...bids.map(r => Number(r.size) || 0));

    const rowHtml = (r, side, maxSize) => {
      const p = p4(r.price);
      const size = Number(r.size) || 0;
      const usdt = Number(r.usdt) || 0;
      const pct = Math.min(100, 100 * size / maxSize);
      return `<div class="book-row ${side}"><div class="depth-bg" style="width:${pct.toFixed(1)}%"></div>`
        + `<span class="book-price" data-side="${side === 'ask' ? 'ask' : 'bid'}" data-price="${p}" style="cursor:pointer" title="${side === 'ask' ? '点击填为卖单限价' : '点击切换为市价买入'}">$${p}</span>`
        + `<span>${fmtA(size)}</span>`
        + `<span>$${usdt.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span></div>`;
    };
    const emptyRow = (txt) => `<div class="book-row" style="justify-content:center;color:#5f6f6c;font-size:11px;padding:6px 0"><span style="display:block;grid-column:1/-1;text-align:center;white-space:nowrap;font-weight:400">${txt}</span></div>`;

    // 卖盘高价在上：后端最优价（最低）在前 → reverse
    askBox.innerHTML = asks.length
      ? asks.slice().reverse().map(r => rowHtml(r, 'ask', maxAsk)).join('')
      : emptyRow('暂无卖单 · 挂卖单后显示');
    // 买盘最优价（最高）在上，直接渲染
    bidBox.innerHTML = bids.length
      ? bids.map(r => rowHtml(r, 'bid', maxBid)).join('')
      : emptyRow('暂无买单 · 挂买单后显示');

    // 更新中间现价
    const markEl = document.getElementById('atrade-book-mark');
    if (markEl) {
      const mp = bookData?.markPrice != null ? p4(bookData.markPrice) : p4(poolStats?.priceUsdt);
      markEl.textContent = '$' + mp;
    }

    // 订单簿点价即填
    try {
      document.querySelectorAll('#atrade-book-panel .book-price').forEach(el => {
        el.addEventListener('click', (e) => {
          const price = e.currentTarget.dataset.price;
          const side_ = e.currentTarget.dataset.side;
          if (!price) return;
          // 点 bid → 切 side=buy；点 ask → 切 side=sell
          const newSide = side_ === 'bid' ? 'buy' : 'sell';
          window.atradeSide(newSide);
          // 买盘点击只能切到市价买入；卖盘点击才允许带入限价。
          if (newSide === 'sell') window.atradeOrderType('limit');
          const pinp = document.getElementById('atrade-input-price');
          if (pinp && newSide === 'sell') {
            pinp.value = price;
            window.atradeInputChanged(true);
          } else if (pinp) {
            pinp.value = '';
          }
        });
      });
    } catch {}
  };

  // ── 滑条 → 输入框 ──
  function maxAmount() {
    const p = profile || {};
    return currentSide === 'buy' ? Number(p.balances?.USDT || 0) : Number(p.balances?.A || 0);
  }
  window.atradeSliderFill = (pct) => {
    const slider = document.getElementById('atrade-slider');
    if (slider) slider.value = String(pct);
    window.atradeSliderChanged(pct);
  };
  window.atradeSliderChanged = (pctVal) => {
    const pct = Number(pctVal) || 0;
    const max = maxAmount();
    let v = max * (pct / 100);
    // 买入时小数点保留 4 位（USDT）
    v = currentSide === 'buy' ? (Math.floor(v * 1e4) / 1e4) : (Math.floor(v * 1e8) / 1e8);
    const input = document.getElementById('atrade-input-amount');
    if (input) {
      input.value = v > 0 ? String(v) : '';
      window.atradeInputChanged(true);
    }
  };

  // ── 输入变化 → 调报价 → 更新 UI ──
  let quoteTimer = null;
  window.atradeInputChanged = async (fromSlider = false) => {
    const requestId = ++quoteRequestId;
    const input = document.getElementById('atrade-input-amount');
    const slider = document.getElementById('atrade-slider');
    const max = maxAmount();
    if (input && slider && !fromSlider && max > 0) {
      const n = Number(input.value || 0);
      const pct = Math.min(100, (n / max) * 100);
      slider.value = String(pct);
    }
    // 摘要 & 报价
    const sv = document.getElementById('atrade-summary-value');
    const sf = document.getElementById('atrade-summary-fee');
    if (!input) return;
    const amt = input.value?.trim();
    if (!amt) {
      if (sv) sv.textContent = '$0.00';
      if (sf) sf.textContent = '0 AIX';
      // 清空 quote 展示
      const e = (id) => document.getElementById(id);
      if (currentSide === 'buy') {
        if (e('q-buy-a'))     e('q-buy-a').textContent = '—';
        if (e('q-buy-price')) e('q-buy-price').textContent = '—';
      } else {
        if (e('q-sell-usdt')) e('q-sell-usdt').textContent = '—';
        if (e('q-sell-fee'))  e('q-sell-fee').textContent  = '—';
        if (e('q-sell-burn')) e('q-sell-burn').textContent = '—';
        if (e('q-sell-div'))  e('q-sell-div').textContent  = '—';
      }
      return;
    }

    // HTML number 输入在部分 WebView 仍可能产生非数字文本；不要把无效值
    // 发送给 API，也不要让上一笔报价继续停留在摘要中。
    if (!(Number(amt) > 0) || !Number.isFinite(Number(amt))) {
      if (sv) sv.textContent = '$0.00';
      if (sf) sf.textContent = '请输入有效数量';
      return;
    }

    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(async () => {
      try {
        let q;
        if (currentOrderType === 'limit') {
          // 限价单：取限价输入框
          const priceInput = document.getElementById('atrade-input-price');
          const priceUsdt = String(priceInput?.value || '').trim();
          if (!priceUsdt) {
            if (sv) sv.textContent = '$0.00';
            if (sf) sf.textContent = '请先填写限价';
          return;
          }
          q = await api(`orders/quote?side=${currentSide}&priceUsdt=${encodeURIComponent(priceUsdt)}&amount=${encodeURIComponent(amt)}`);
        } else {
          q = await api(`quote?side=${currentSide}&amount=${encodeURIComponent(amt)}`);
        }
        if (requestId !== quoteRequestId) return;
        const e = (id) => document.getElementById(id);
        if (currentSide === 'buy') {
          if (e('q-buy-a'))     e('q-buy-a').textContent     = `${fmtA(q.aOut)} AIX`;
          if (e('q-buy-price')) e('q-buy-price').textContent = q.priceUsdt != null ? fmtUsdt(q.priceUsdt) : '—';
          if (sv) sv.textContent = fmtUsdt(q.amountUsdt || q.usdtIn || 0);
          if (sf) sf.textContent = '$0.00（买方免）';
        } else {
          if (e('q-sell-usdt')) e('q-sell-usdt').textContent = fmtUsdt(q.usdtOut);
          // 卖方手续费按直推人数阶梯：未登录或直推 0~1→50%, 2~3→40%, 4~5→30%, 6~7→20%, 8~9→10%, ≥10→3%
          const feeLbl = e('q-sell-fee-lbl');
          if (feeLbl && q.feePct) feeLbl.textContent = `手续费 (${q.feePct}${q.directCount != null ? ` · 直推${q.directCount}人` : ''} · 成交时扣)`;
          if (e('q-sell-fee'))  e('q-sell-fee').textContent  = `-${fmtA(q.feeA)} AIX`;
          // 手续费固定 50% 销毁 + 50% 进 A10 池（不受后台销毁开关影响）
          if (e('q-sell-burn')) e('q-sell-burn').textContent = `-${fmtA(Number(q.feeA)/2)} AIX`;
          if (e('q-sell-div'))  e('q-sell-div').textContent  = `-${fmtA(Number(q.feeA)/2)} AIX`;
          if (sv) sv.textContent = fmtUsdt(q.amountUsdt || (q.aIn ? (Number(q.aIn) * Number(q.priceUsdt || 0)) : 0));
          if (sf) sf.textContent = `${fmtA(q.feeA)} AIX（50%销毁 ${fmtA(Number(q.feeA)/2)} + 50%进A10池 ${fmtA(Number(q.feeA)/2)}）`;
        }
      } catch (e) {
        // 忽略
      }
    }, 300);
  };

  // ── 提交下单（统一新接口 /api/a-token/orders） ──
  window.atradeSubmit = async () => {
    if (!profile) {
      if (typeof showToast === 'function') showToast('请先连接并确认钱包', 'error');
      else alert('请先连接并确认钱包');
      return;
    }
    const inp = document.getElementById('atrade-input-amount');
    const amt = inp?.value?.trim();
    if (!amt) { showErr(currentSide === 'buy' ? '请输入支付 USDT 数量' : '请输入卖出 AIX 数量'); return; }
    const max = maxAmount();
    if (Number(amt) > max) {
      showErr(currentSide === 'buy' ? `USDT 余额不足（当前 ${fmtUsdt(max)}）` : `AIX 余额不足（当前可用 ${fmtA(max)} AIX）`);
      return;
    }

    // 买卖双方均支持市价跟随 / 限价委托
    const submitOrderType = currentOrderType;
    let priceUsdt = undefined;
    if (submitOrderType === 'limit') {
      const pinp = document.getElementById('atrade-input-price');
      const pv = String(pinp?.value || '').trim();
      if (!pv) { showErr('请填写限价（USDT / AIX）'); return; }
      if (Number(pv) <= 0) { showErr('限价必须大于 0'); return; }
      priceUsdt = pv;
    }
    try {
      const r = await authApi('orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side: currentSide, orderType: submitOrderType, priceUsdt, amount: amt }),
      });
      if (r.orderStatus === 'FILLED') {
        if (currentSide === 'buy') showOk(`买入成功 · 支付 ${fmtUsdt(r?.usdtPaid || amt)}，获得 ${fmtA(r?.aReceived)} AIX`);
        else showOk(`卖出成功 · 卖出 ${fmtA(r?.aSold || amt)} AIX，净得 ${fmtUsdt(r?.usdtReceived)}，扣手续费 ${fmtA(r?.feeA)} AIX（50%销毁+50%进A10池）`);
      } else if (r.orderStatus === 'OPEN' && r.partialFilled) {
        showOk(`${currentSide === 'buy'
          ? `已成交部分：获得 ${fmtA(r.aReceived)} AIX；剩余自动挂单（冻结 ${fmtUsdt(r.lockedUsdt)} USDT）`
          : `已成交部分：净得 ${fmtUsdt(r.usdtReceived)}；剩余自动挂单（冻结 ${fmtA(r.lockedA)} AIX）`} · 等待对手方`);
      } else if (r.orderStatus === 'OPEN') {
        showOk(`暂无对手方挂单 · 已转为${currentSide === 'buy' ? '求购委托' : '挂牌委托'} · 冻结 ${currentSide === 'buy' ? fmtUsdt(r.lockedUsdt) + ' USDT' : fmtA(r.lockedA) + ' AIX'}${currentSide === 'sell' ? '（手续费成交时划扣）' : ''}`);
      } else {
        showOk('下单成功');
      }
      if (inp) inp.value = '';
      const slider = document.getElementById('atrade-slider');
      if (slider) slider.value = 0;
      await load();
    } catch (e) { showErr(friendlyError(e, submitOrderType === 'limit' ? '挂单失败' : (currentSide === 'buy' ? '买入失败' : '卖出失败'))); }
  };

  // ── 我的委托：拉取列表 + 渲染 ──
  window.atradeRefreshOrders = async () => {
    if (!profile) return;
    try {
      const res = await authApi('orders?limit=200');
      myOrdersCache = res?.orders || [];
      window.atradeRenderAccount();
    } catch (e) {
      // ignore
    }
    // 顺带刷新冻结中资金展示（对手方吃单/成交也会改变冻结额）
    atradeRefreshBalances();
  };

  // 委托轮询时轻量刷新 profile（顶部余额四格已移除，这里仅刷新数据与底部账户面板）
  async function atradeRefreshBalances() {
    if (!profile) return;
    if (typeof authApi !== 'function') return;
    try {
      const p = await authApi('profile');
      profile = p;
      // 资产/持仓 tab 激活时同步刷新账户面板
      if (accountTab === 'balances' || accountTab === 'positions') window.atradeRenderAccount();
    } catch (e) { /* ignore */ }
  }
  // ── 底部账户面板：五 tab 渲染（资产/持仓/当前委托/历史委托/成交历史），样式对齐现货终端 ──
  window.atradeAccountTab = (view) => {
    accountTab = ['balances', 'positions', 'orders', 'history', 'fills'].includes(view) ? view : 'balances';
    document.querySelectorAll('#atrade-account-tabs button').forEach(b => {
      b.classList.toggle('active', b.dataset.aview === accountTab);
    });
    window.atradeRenderAccount();
  };

  window.atradeRenderAccount = () => {
    const host = document.getElementById('atrade-account-content');
    if (!host) return;
    const p = profile || {};
    const price = Number(poolStats?.priceUsdt || 0.1);
    const balU = Number(p.balances?.USDT || 0), balA = Number(p.balances?.A || 0);
    const lockU = Number(p.locked?.usdt || 0), lockA = Number(p.locked?.a || 0);
    const zTime = d => new Date(d).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');

    if (accountTab === 'balances') {
      host.innerHTML = `<table class="terminal-data-table"><thead><tr><th>资产</th><th>余额</th><th>冻结中</th><th>市值</th></tr></thead><tbody>
        <tr><td data-label="资产" class="asset-name">USDT</td><td data-label="余额">${fmtUsdt(balU)}</td><td data-label="冻结中">${fmtUsdt(lockU)}</td><td data-label="市值">${fmtUsdt(balU)}</td></tr>
        <tr><td data-label="资产" class="asset-name">AIX</td><td data-label="余额">${fmtA(balA)}</td><td data-label="冻结中">${fmtA(lockA)}</td><td data-label="市值">${fmtUsdt(balA * price)}</td></tr>
      </tbody></table>`;
      return;
    }
    if (accountTab === 'positions') {
      if (!(balA > 0)) { host.innerHTML = '<div class="terminal-empty">暂无 AIX 持仓</div>'; return; }
      host.innerHTML = `<table class="terminal-data-table"><thead><tr><th>市场</th><th>持仓数量</th><th>冻结中</th><th>现价</th><th>市值</th></tr></thead><tbody>
        <tr><td data-label="市场">AIX/USDT</td><td data-label="持仓数量">${fmtA(balA)} AIX</td><td data-label="冻结中">${fmtA(lockA)} AIX</td><td data-label="现价">${fmtUsdt(price)}</td><td data-label="市值">${fmtUsdt(balA * price)}</td></tr>
      </tbody></table>`;
      return;
    }
    if (accountTab === 'orders' || accountTab === 'history') {
      const list = Array.isArray(myOrdersCache) ? myOrdersCache : [];
      const filtered = accountTab === 'orders'
        ? list.filter(o => o.orderStatus === 'OPEN')
        : list.filter(o => o.orderStatus !== 'OPEN');
      if (!filtered.length) { host.innerHTML = `<div class="terminal-empty">${accountTab === 'orders' ? '暂无当前委托' : '暂无历史委托'}</div>`; return; }
      const rows = filtered.map(o => {
        // 委托量 = 剩余冻结 + 累计成交（FILLED 时剩余为 0，撤单时剩余为退回部分；不能只显示剩余，否则已成交单显示 0）
        const size = o.side === 'buy'
          ? `${fmtUsdt(Number(o.inputUsdt || 0) + Number(o.filledUsdt || 0))} USDT`
          : `${fmtA(Number(o.inputA || 0) + Number(o.filledA || 0))} AIX`;
        const status = o.orderStatus === 'OPEN' ? '<span style="color:#f6c454">挂单中</span>'
          : o.orderStatus === 'FILLED' ? '<span style="color:#50d2b8">已成交</span>'
          : o.orderStatus === 'CANCELLED' ? '<span style="color:#81918e">已撤单</span>'
          : `<span>${o.orderStatus}</span>`;
        const action = o.orderStatus === 'OPEN'
          ? `<button class="table-action" onclick="window.atradeCancelOrder('${o.orderId}')">撤单</button>`
          : (o.fillPriceUsdt ? `<span style="color:#81918e">${fmtUsdt(o.fillPriceUsdt)}</span>` : '—');
        const fillCell = accountTab === 'history'
          ? `<td data-label="成交价">${o.fillPriceUsdt ? fmtUsdt(o.fillPriceUsdt) : '—'}</td>` : '';
        const orderTypeLabel = o.orderType === 'market' ? '市价' : '限价';
        return `<tr><td data-label="时间">${zTime(o.createdAt)}</td><td data-label="方向" class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? '买入' : '卖出'}</td><td data-label="类型">${orderTypeLabel}</td><td data-label="委托价">${fmtUsdt(o.orderPriceUsdt)}</td><td data-label="委托量">${size}</td>${fillCell}<td data-label="状态">${status}</td><td data-label="操作">${action}</td></tr>`;
      }).join('');
      const head = accountTab === 'orders'
        ? '<th>时间</th><th>方向</th><th>类型</th><th>委托价</th><th>委托量</th><th>状态</th><th>操作</th>'
        : '<th>时间</th><th>方向</th><th>类型</th><th>委托价</th><th>委托量</th><th>成交价</th><th>状态</th><th>操作</th>';
      host.innerHTML = `<table class="terminal-data-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
      return;
    }
    // fills · 成交历史
    const trades = p.trades || [];
    if (!trades.length) { host.innerHTML = '<div class="terminal-empty">暂无成交记录</div>'; return; }
    const rows = trades.map(t => `<tr><td data-label="时间">${zTime(t.createdAt)}</td><td data-label="方向" class="${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? '买入' : '卖出'}</td><td data-label="价格">${fmtUsdt(t.priceUsdt)}</td><td data-label="数量">${fmtA(t.size)} AIX</td><td data-label="成交额">${fmtUsdt(t.amountUsdt)}</td><td data-label="销毁" style="color:#f26c78">${t.burn ? `${fmtA(t.burn)} AIX` : '—'}</td><td data-label="入A10池" style="color:#f6c454">${t.dividend ? `${fmtA(t.dividend)} AIX` : '—'}</td></tr>`).join('');
    host.innerHTML = `<table class="terminal-data-table"><thead><tr><th>时间</th><th>方向</th><th>价格</th><th>数量</th><th>成交额</th><th>销毁</th><th>入A10池</th></tr></thead><tbody>${rows}</tbody></table>`;
  };
  window.atradeCancelOrder = async (orderId) => {
    if (!orderId || !await confirmDialog('确定要撤单吗？冻结资产将原路退回。')) return;
    try {
      const r = await authApi(`orders/${encodeURIComponent(orderId)}`, { method: 'DELETE' });
      showOk(`撤单成功 · 退回 ${Number(r.refundUsdt)>0 ? fmtUsdt(r.refundUsdt)+' USDT' : fmtA(r.refundA)+' A'}`);
      await load();
    } catch (e) { showErr(friendlyError(e, '撤单失败')); }
  };

  // ── K 线交互 ──
  window.atradeInitChart = () => {
    const host = document.getElementById('atrade-chart');
    if (!host || typeof LightweightCharts === 'undefined') return;
    // 页面刷新/下单后会重建 K 线实例，先清理旧的观察器与监听器，
    // 防止每次重载都叠加 resize 回调并持有旧 DOM 闭包。
    atradeChartResizeObserver?.disconnect?.();
    atradeChartResizeObserver = null;
    if (atradeChartResizeHandler) window.removeEventListener('resize', atradeChartResizeHandler);
    if (atradeChartViewportHandler) window.visualViewport?.removeEventListener?.('resize', atradeChartViewportHandler);
    atradeChartResizeHandler = null;
    atradeChartViewportHandler = null;
    if (atradeChart) { try { atradeChart.remove(); } catch {} atradeChart = null; atradeCandleSeries = null; }
    if (atradeKlineTimer) { clearInterval(atradeKlineTimer); atradeKlineTimer = null; }

    const theme = window.WGTheme?.chartOptions?.() || {
      layout:{ background:{ type:'solid', color:'#0b1113' }, textColor:'#91a19b' },
      grid:{ vertLines:{ color:'#19211f' }, horzLines:{ color:'#19211f' } },
      rightPriceScale:{ borderColor:'#202a27' }, timeScale:{ borderColor:'#202a27' },
    };
    const tzOpts = (typeof window.wgChartTzOptions === 'function') ? window.wgChartTzOptions() : { localization:{}, timeScale:{} };
    atradeChart = LightweightCharts.createChart(host, {
      width: host?.clientWidth || 600,
      height: host?.clientHeight || 360,
      layout:{ ...theme.layout, fontFamily:'-apple-system, Segoe UI, sans-serif' },
      grid:theme.grid,
      crosshair:{ mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale:{ ...theme.rightPriceScale, scaleMargins:{ top:0.08, bottom:0.08 } },
      timeScale:{ ...theme.timeScale, ...tzOpts.timeScale, timeVisible:true, secondsVisible:false, rightOffset:4, barSpacing:8, fixLeftEdge:true },
      localization:{ locale:'zh-CN', ...tzOpts.localization },
    });
    // base.css turns ordinary mobile tables into stacked cards. Lightweight
    // Charts uses a private table to place the candle pane and price scale
    // beside each other, so opt that internal table out of the card rules.
    host.querySelectorAll('.tv-lightweight-charts table').forEach(table => table.classList.add('no-mobile-stack'));
    // 手动接管尺寸同步：autoSize 在 iOS / 窄屏容器下测量不准（手机端 K 线偏移/留白）
    const fitAtradeChart = () => {
      if (!atradeChart) return;
      const w = host?.clientWidth || 0;
      const h = host?.clientHeight || 360;
      if (w > 0) atradeChart.applyOptions({ width:w, height:h });
    };
    if (window.ResizeObserver && host) {
      atradeChartResizeObserver = new ResizeObserver(fitAtradeChart);
      atradeChartResizeObserver.observe(host);
    }
    atradeChartResizeHandler = fitAtradeChart;
    atradeChartViewportHandler = fitAtradeChart;
    window.addEventListener('resize', atradeChartResizeHandler);
    window.visualViewport?.addEventListener?.('resize', atradeChartViewportHandler);
    fitAtradeChart();
    atradeCandleSeries = atradeChart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor:'#4fd1b5', downColor:'#f06f75', borderVisible:false, wickUpColor:'#4fd1b5', wickDownColor:'#f06f75',
    });
    atradeCandleSeries.priceScale().applyOptions({
      autoScale:true,
    });
    atradeCandleSeries.applyOptions({
      priceFormat:{ type:'price', precision:4, minMove: 0.0001 },
    });

    window.atradeLoadKline(atradePeriod);

    atradeKlineTimer = setInterval(() => {
      window.atradeRefreshKline().catch(err => console.warn('[A Trade Chart] refresh fail', err?.message || err));
    }, 10_000);
  };

  window.atradeSwitchPeriod = async (period) => {
    atradePeriod = period;
    document.querySelectorAll('.atrade-chart-tabs button').forEach(b => {
      b.classList.toggle('active', b.dataset.period === period);
    });
    await window.atradeLoadKline(period);
  };

  window.atradeLoadKline = async (period) => {
    if (!atradeCandleSeries) return;
    const seq = ++atradeDataSeq;
    const res = await api(`kline?period=${encodeURIComponent(period)}&limit=500`);
    // 网络往返期间用户又切了周期/图表被销毁：本响应过期，丢弃
    if (seq !== atradeDataSeq || !atradeCandleSeries) return;
    const candles = (res?.candles || []).map(c => ({
      time: Number(c.time),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    }));
    if (candles.length === 0) return;
    atradeCandleSeries.setData(candles);
    atradeLastTime = candles[candles.length - 1].time;
    try { atradeChart.timeScale().fitContent(); } catch {}
  };

  window.atradeRefreshKline = async () => {
    if (!atradeCandleSeries) return;
    const reqPeriod = atradePeriod;
    const res = await api(`kline?period=${encodeURIComponent(atradePeriod)}&limit=5`);
    // 往返期间切了周期/图表被销毁：旧周期响应丢弃，避免 update 早于新数据首根的 bar
    if (reqPeriod !== atradePeriod || !atradeCandleSeries) return;
    const candles = res?.candles || [];
    if (!candles.length) return;
    // 增量：最后 1-2 根 update，如有新 bar 则追加
    const sorted = candles.map(c => ({ time: Number(c.time), open: +c.open, high: +c.high, low: +c.low, close: +c.close }))
      .sort((a,b) => a.time - b.time);
    for (const bar of sorted) {
      // 单根异常（如早于图表最早一根）不影响其余 bar 更新
      try { atradeCandleSeries.update(bar); } catch {}
    }
    atradeLastTime = sorted[sorted.length - 1].time;
  };

  P.register('a-token-trade', { render, load, fail: e => { const h = document.getElementById('atrade-content'); if (h) h.innerHTML = P.error(e.message, "Portal.load('a-token-trade',true)"); } });
})();
