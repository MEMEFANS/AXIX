(function () {
  let symbols = ['USDT', 'A', 'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE'];
  const names = { USDT:'Tether', BTC:'Bitcoin', ETH:'Ethereum', BNB:'BNB', SOL:'Solana', XRP:'XRP', DOGE:'Dogecoin', A:'AxiX 平台原生代币' };
  // 内部代码 'A' 对外统一显示为 'AIX'（资金/交易接口仍用内部代码）
  const disp = (symbol) => symbol === 'A' ? 'AIX' : symbol;
  // 图标全部本地化（币安 CDN 在部分网络下加载慢），本地缺失时回退币安 logo 库；'A' 不可用 CDN 的 A.png（第三方代币图标）
  const logo = symbol => `/assets/tokens/${symbol.toLowerCase()}.png?v=5`;
  const remoteLogo = symbol => symbol === 'A' ? '/assets/tokens/a.png?v=4' : `https://bin.bnbstatic.com/static/assets/logos/${symbol}.png`;
  let wallet = null;
  let platform = null;
  let transfersSeq = 0, revenueSeq = 0;

  function node(id) { return document.getElementById(id); }
  function value(input) { const number = Number(input); return Number.isFinite(number) ? number : 0; }
  function amount(input) {
    return value(input).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
  }
  function money(input) {
    return value(input).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
  }
  function quantity(input, symbol) {
    if (symbol !== 'A') return amount(input);
    const number = value(input);
    if (number > 0 && number < 0.00000001) return '&lt;0.00000001';
    return number.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:8 });
  }
  function setText(id, text) { if (node(id)) node(id).textContent = text; }

  function accountParts() {
    const account = platform?.account || {};
    return [
      { name:'可用资金', value:value(account.availableMargin) },
      { name:'现货账户', value:value(account.spotValue) },
      { name:'合约账户', value:value(account.positionEquity) },
      { name:'策略与跟单', value:value(account.strategyValue) },
      { name:'质押账户', value:value(account.stakingValue) },
    ];
  }

  function renderSummary() {
    const account = platform?.account || {};
    const total = value(account.totalEquity || wallet?.balances?.USDT);
    setText('assets-total-equity', money(total));
    setText('assets-total-usd', money(total));
    setText('assets-spot-value', money(account.spotValue));
    setText('assets-contract-value', money(account.positionEquity));
    setText('assets-strategy-value', money(account.strategyValue));
    setText('assets-updated-at', platform ? `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12:false })}` : '等待账户数据');

    const parts = accountParts();
    const denominator = Math.max(total, parts.reduce((sum, item) => sum + Math.max(0, item.value), 0), 0);
    const host = node('assets-allocation');
    if (host) host.innerHTML = parts.map(item => {
      const percent = denominator > 0 ? Math.max(0, item.value) / denominator * 100 : 0;
      return `<div class="assets-allocation-item"><div class="assets-allocation-name"><span>${item.name}</span><b>${money(item.value)}</b></div><div class="assets-allocation-track"><div class="assets-allocation-fill" style="width:${Math.min(100, percent).toFixed(2)}%"></div></div></div>`;
    }).join('');
  }

  function assetRow(symbol) {
    const account = platform?.account || {};
    const isUsdt = symbol === 'USDT';
    // AIX is a wallet ledger balance. Show it as soon as the wallet responds,
    // even while the platform's market/position profile is still loading.
    const available = isUsdt ? value(account.availableMargin ?? wallet?.balances?.USDT)
      : symbol === 'A' ? value(wallet?.balances?.A ?? platform?.spot?.A)
        : value(platform?.spot?.[symbol]);
    const frozen = isUsdt ? value(account.reservedUsdt) : value(platform?.spotFrozen?.[symbol]);
    const total = available + frozen;
    const price = isUsdt ? 1 : value(platform?.marketPrices?.[symbol]);
    return { symbol, available, frozen, total, valuation:total * price };
  }

  function renderAssets() {
    const query = String(node('assets-search')?.value || '').trim().toUpperCase();
    const hideZero = Boolean(node('assets-hide-zero')?.checked);
    const rows = symbols.map(assetRow).filter(item => (!query || disp(item.symbol).includes(query) || item.symbol.includes(query) || String(names[item.symbol] || item.symbol).toUpperCase().includes(query)) && (!hideZero || item.total > 0));
    const host = node('assets-table-body');
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = '<tr><td colspan="6" class="account-empty">没有符合条件的资产</td></tr>';
      return;
    }
    host.innerHTML = rows.map(item => {
      const actions = item.symbol === 'USDT'
        ? '<button onclick="window.ExchangeAssets.openFunding(\'deposit\')">充值</button><button onclick="window.ExchangeAssets.openFunding(\'withdraw\')">提现</button>'
        : item.symbol === 'A'
          ? '<button onclick="window.ExchangeAssets.openAix(\'transfer\',this)">互转</button><button onclick="window.ExchangeAssets.openAix(\'withdrawal\',this)">提现</button><button onclick="window.ExchangeAssets.openTrade(\'A\')">交易</button>'
          : `<button onclick="window.ExchangeAssets.openTrade('${item.symbol}')">交易</button>`;
      const fallbackLogo = `/assets/tokens/${item.symbol.toLowerCase()}.png?v=5`;
      return `<tr><td><div class="assets-coin"><span class="assets-coin-icon ${item.symbol.toLowerCase()}"><span class="assets-coin-fallback">${disp(item.symbol).slice(0,1)}</span><img src="${logo(item.symbol)}" alt="${disp(item.symbol)}" loading="lazy" onerror="if(!this.dataset.f){this.dataset.f=1;this.src='${remoteLogo(item.symbol)}'}else{this.onerror=null;this.src='${fallbackLogo}'}"></span><span><b>${disp(item.symbol)}</b><small>${names[item.symbol] || disp(item.symbol)}</small></span></div></td><td><span class="assets-total-amount">${quantity(item.total,item.symbol)}</span><small class="assets-mobile-valuation">≈ ${money(item.valuation)} USDT</small></td><td>${quantity(item.available,item.symbol)}</td><td>${quantity(item.frozen,item.symbol)}</td><td>${money(item.valuation)}</td><td class="assets-row-actions">${actions}</td></tr>`;
    }).join('');
  }

  function renderWallet(profile) {
    const nextAddress = profile?.address?.toLowerCase();
    const previousAddress = wallet?.address?.toLowerCase();
    if (!profile || profile.authenticated === false || (previousAddress && nextAddress && previousAddress !== nextAddress)) {
      platform = null; ++transfersSeq; ++revenueSeq;
    }
    wallet = profile?.authenticated === false ? null : profile || null;
    renderSummary();
    renderAssets();
  }

  function renderPlatform(profile) {
    platform = profile || null;
    if (Array.isArray(profile?.symbols)) {
      symbols = ['USDT', ...profile.symbols.filter(symbol => symbol !== 'USDT')];
    }
    // AIX 代币：AxiX 平台内生态代币，资产表固定展示（数据来自 platform.spot.A / spotFrozen.A，前端以 AIX 单位展示）
    if (!symbols.includes('A')) symbols.splice(1, 0, 'A');
    renderSummary();
    renderAssets();
    renderCapitalHistory();
  }

  function renderCapitalHistory() {
    const host = node('capital-history');
    if (!host) return;
    const cards = document.getElementById('capital-history-cards');
    const labels = { spot_trade:'现货成交', perp_trade:'合约成交', liquidation:'强制平仓', funding:'资金费', stake:'质押', unstake:'赎回质押', strategy_balance_consolidated:'策略划转', internal_strategy_settle:'策略结算', ai_copy_start:'加入跟单', ai_copy_redeem:'跟单赎回', aix_trade:'AIX 交易', lottery_win:'抽奖中奖', deposit:'充值', withdrawal:'提现' };
    const withdrawStatusMap = { pending_review:'正在提现', pending_funds:'正在提现', pending_auto:'自动出款中', processing:'准备出款', signed:'等待广播', broadcast:'链上确认中', payout_failed:'出款失败', paid:'已到账', rejected:'已驳回·已退款', refunded:'已退回' };
    const rows = (platform?.capitalHistory || []).map(item => {
      const isFund = item.type === 'deposit' || item.type === 'withdrawal';
      const isAix = item.type === 'aix_trade';
      const netPnl = item.netPnl != null ? Number(item.netPnl) : (item.pnl != null ? Number(item.pnl) - Number(item.fee || 0) : null);
      const amount = item.amount == null ? (netPnl == null ? '' : `${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)}`) : `${Number(item.amount) >= 0 ? '+' : ''}${Number(item.amount).toFixed(2)}`;
      const pnl = netPnl == null ? amount : `${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)}`;
      const direction = isFund
        ? (item.type === 'deposit' ? '充入' : '提出')
        : isAix ? (item.side === 'buy' ? '买入' : item.side === 'sell' ? '卖出' : '—') : (item.side === 'buy' ? '买入/做多' : item.side === 'sell' ? '卖出/做空' : '—');
      const isLot = item.type === 'lottery_win';
      const lotSymbol = isLot ? String(item.symbol || '').toUpperCase() : '';
      const fundSymbol = String(item.symbol || 'USDT').toUpperCase();
      const market = isFund ? fundSymbol : isLot ? lotSymbol : (item.symbol ? `${item.symbol}/USDT` : '—');
      const size = item.size == null ? '—' : Number(item.size).toLocaleString('en-US', { maximumFractionDigits:8 });
      const price = item.price == null ? '—' : Number(item.price).toLocaleString('en-US', { minimumFractionDigits: isAix ? 4 : 2, maximumFractionDigits: isAix ? 6 : 2 });
      const fee = item.fee == null || isFund ? '—' : isAix ? `${Number(item.fee).toFixed(4)} AIX` : `${Number(item.fee).toFixed(2)} USDT`;
      const valueClass = (netPnl ?? Number(item.amount ?? 0)) >= 0 ? 'up' : 'down';
      // AIX 交易：买入主金额 = 到账数量；卖出主金额 = 投入量（净成交 + 手续费，按投入量收费口径）
      const isBuy = item.side === 'buy';
      const feeNum = isAix && item.fee != null ? Number(item.fee) : 0;
      const aixValue = isAix && item.size != null
        ? isBuy
          ? `+${Number(item.size).toLocaleString('en-US', { maximumFractionDigits:4 })} AIX`
          : `−${(Number(item.size) + feeNum).toLocaleString('en-US', { maximumFractionDigits:4 })} AIX`
        : null;
      // 卖出实际到账 USDT = 净成交 × 成交价
      const proceeds = isAix && !isBuy && item.size != null && item.price != null
        ? (Number(item.size) * Number(item.price)).toFixed(2)
        : null;
      // 抽奖中奖：显示中奖币种数量（抽中 USDT 则自然显示 USDT），不显示 USDT 估值
      const lotteryValue = isLot && item.size != null && lotSymbol
        ? `+${Number(item.size).toLocaleString('en-US', { maximumFractionDigits:8 })} ${lotSymbol}`
        : null;
      // 充值/提现流水：带币种符号的正负金额，状态取提现单实时状态
      const fundValue = isFund && item.size != null
        ? `${item.type === 'deposit' ? '+' : '−'}${Number(item.size).toLocaleString('en-US', { maximumFractionDigits:8 })} ${fundSymbol}`
        : null;
      const typeLabel = labels[item.type] || item.type || '账户变动';
      const statusLabel = isFund
        ? (item.type === 'deposit' ? '已到账' : (withdrawStatusMap[item.status] || item.status || '处理中'))
        : item.liquidation ? '已强平' : '已完成';
      const date = new Date(item.createdAt);
      const timeFull = date.toLocaleString('zh-CN', { hour12:false });
      const timeShort = date.toLocaleString('zh-CN', { hour12:false, month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
      const value = fundValue || lotteryValue || aixValue || pnl || amount || '—';
      const displayClass = fundValue ? (item.type === 'deposit' ? 'up' : 'down') : aixValue ? (isBuy ? 'up' : 'down') : lotteryValue ? 'up' : valueClass;
      return { typeLabel, market, direction, size, price, fee, statusLabel, timeFull, timeShort, value, valueClass: displayClass, isAix, isBuy, proceeds, symbol: item.symbol || '', isFund };
    });
    const unitSuffix = v => /\s(BTC|ETH|BNB|USDT|AIX)$/.test(v) ? '' : ' USDT';
    host.innerHTML = rows.map(r => `<tr><td data-label="时间">${r.timeFull}</td><td data-label="类型">${r.typeLabel}</td><td data-label="市场">${r.market}</td><td data-label="方向">${r.direction}</td><td data-label="数量">${r.size}</td><td data-label="价格">${r.price}</td><td data-label="手续费">${r.fee}</td><td data-label="净盈亏" class="${r.valueClass}">${r.value}${unitSuffix(r.value)}</td><td data-label="状态">${r.statusLabel}</td></tr>`).join('')
      || '<tr><td colspan="9" class="account-empty">暂无交易及账户流水</td></tr>';
    if (cards) {
      cards.innerHTML = rows.map(r => {
        const detail = [
          ['市场', r.market], ['方向', r.direction], ['数量', r.size], ['价格', r.price],
          ['手续费', r.fee],
          ...(!r.isBuy && r.proceeds != null ? [['卖出到账', `+${r.proceeds} USDT`]] : []),
          ['状态', r.statusLabel], ['时间', r.timeFull],
        ].map(([k, v]) => `<div><i>${k}</i><b>${v}</b></div>`).join('');
        const sub = r.market !== '—' ? `<small>${r.market}</small>` : '';
        return `<div class="rec-card"><div class="rec-head"><span class="rec-type">${r.typeLabel}${sub}</span><span class="rec-amount ${r.valueClass}">${r.value}${unitSuffix(r.value)}</span></div><div class="rec-meta"><span>${r.timeShort}</span><span class="rec-open"></span></div><div class="rec-detail">${detail}</div></div>`;
      }).join('') || '<div class="account-empty rec-empty">暂无交易及账户流水</div>';
    }
  }

  function setView(view) {
    const balances = view === 'balances';
    const records = view === 'records';
    const revenue = view === 'revenue';
    if (node('assets-balances-view')) node('assets-balances-view').hidden = !balances;
    if (node('assets-records-view')) node('assets-records-view').hidden = !records;
    if (node('assets-revenue-view')) node('assets-revenue-view').hidden = !revenue;
    document.querySelectorAll('[data-assets-view]').forEach(button => button.classList.toggle('active', button.dataset.assetsView === view));
    if (revenue) loadRevenue();
    if (records) loadTransfers();
  }

  // AIX 互转记录（/api/a-token/my-transfers）：转入按净额到账，转出展示总额与手续费
  async function loadTransfers() {
    const wallet = Portal.walletKey(), seq = ++transfersSeq;
    const valid = () => seq === transfersSeq && wallet === Portal.walletKey() && window.currentWalletProfile?.authenticated;
    const host = node('aix-transfer-history');
    if (!host) return;
    host.innerHTML = '<tr><td colspan="7" class="account-empty">加载中…</td></tr>';
    try {
      const data = await Portal.readJSON('/api/a-token/my-transfers');
      if (!valid()) return;
      if (data.error) throw new Error(data.error);
      renderTransfers(data.transfers || []);
    } catch (e) {
      if (!valid()) return;
      host.innerHTML = '<tr><td colspan="7" class="account-empty">暂无互转记录</td></tr>';
    }
  }

  function renderTransfers(list) {
    const host = node('aix-transfer-history');
    if (!host) return;
    const cards = document.getElementById('aix-transfer-history-cards');
    if (!list.length) {
      host.innerHTML = '<tr><td colspan="7" class="account-empty">暂无互转记录</td></tr>';
      if (cards) cards.innerHTML = '<div class="account-empty rec-empty">暂无互转记录</div>';
      return;
    }
    const fmtAix = v => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:4 });
    const shortAddr = a => a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : '—';
    const rows = list.map(t => {
      const out = t.direction === 'out';
      const time = new Date(Number(t.createdAt)).toLocaleString('zh-CN', { hour12:false, timeZone:'Asia/Shanghai' });
      const timeShort = new Date(Number(t.createdAt)).toLocaleString('zh-CN', { hour12:false, timeZone:'Asia/Shanghai', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
      const counterparty = out && t.toUserId
        ? `${shortAddr(t.counterparty)}<small style="display:block;color:#7a9488;font-size:10px;margin-top:2px">ID ${esc(String(t.toUserId))}</small>`
        : shortAddr(t.counterparty);
      const net = t.payload?.net ?? '';
      return { out, time, timeShort, counterparty, amount: fmtAix(t.amount), fee: out ? fmtAix(t.fee) : '—', net: out ? '—' : `+${fmtAix(net)}` };
    });
    host.innerHTML = rows.map(r => `<tr>
        <td data-label="时间">${r.time}</td>
        <td data-label="方向">${r.out ? '<span class="aix-tf-badge out">转出</span>' : '<span class="aix-tf-badge in">转入</span>'}</td>
        <td data-label="对方">${r.counterparty}</td>
        <td data-label="数量(AIX)" class="${r.out ? 'down' : 'up'}">${r.out ? '−' : '+'}${r.amount}</td>
        <td data-label="手续费(AIX)">${r.fee}</td>
        <td data-label="到账(AIX)" class="up">${r.net}</td>
        <td data-label="状态">已完成</td>
      </tr>`).join('');
    if (cards) {
      cards.innerHTML = rows.map(r => {
        const detail = [
          ['对方', r.counterparty.replace(/<[^>]+>/g, ' ')], ['手续费', r.fee], ['到账', r.net], ['状态', '已完成'], ['时间', r.time],
        ].map(([k, v]) => `<div><i>${k}</i><b>${v}</b></div>`).join('');
        const badge = r.out ? '<span class="aix-tf-badge out">转出</span>' : '<span class="aix-tf-badge in">转入</span>';
        return `<div class="rec-card"><div class="rec-head"><span class="rec-type">${badge}</span><span class="rec-amount ${r.out ? 'down' : 'up'}">${r.out ? '−' : '+'}${r.amount} AIX</span></div><div class="rec-meta"><span>${r.timeShort}</span><span class="rec-open"></span></div><div class="rec-detail">${detail}</div></div>`;
      }).join('');
    }
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  // 资金记录手机端：点击记录卡片展开/收起完整详情
  document.addEventListener('click', (event) => {
    if (!window.matchMedia('(max-width: 640px)').matches) return;
    const card = event.target.closest?.('.rec-card');
    if (!card) return;
    card.classList.toggle('open');
  });

  async function loadRevenue() {
    const wallet = Portal.walletKey(), seq = ++revenueSeq;
    const valid = () => seq === revenueSeq && wallet === Portal.walletKey() && window.currentWalletProfile?.authenticated;
    const sumHost = node('aix-revenue-summary');
    const listHost = node('aix-revenue-list');
    if (!sumHost || !listHost) return;
    sumHost.textContent = '正在加载…';
    listHost.innerHTML = '<tr><td colspan="5" class="account-empty">加载中…</td></tr>';
    try {
      const data = await Portal.readJSON('/api/a-token/revenue?limit=200');
      if (!valid()) return;
      if (data.error) throw new Error(data.error);
      renderRevenueSummary(data);
      renderRevenueList(data);
    } catch (e) {
      if (!valid()) return;
      sumHost.textContent = '加载失败：' + (e.message || e);
      listHost.innerHTML = '<tr><td colspan="5" class="account-empty">暂无收益记录</td></tr>';
      const revCards = document.getElementById('aix-revenue-cards');
      if (revCards) revCards.innerHTML = '<div class="account-empty rec-empty">暂无收益记录</div>';
    }
  }

  function renderRevenueSummary(data) {
    const host = node('aix-revenue-summary');
    if (!host) return;
    const total = Number(data.total || 0);
    const stats = data.stats || {};
    const summary = data.summary || [];
    const statCard = (label, key) => `<div class="aix-rev-item"><div class="lbl">${label}</div><div class="val">${money(stats[key] ?? 0)} <small>AIX</small></div></div>`;
    if (!summary.length) {
      host.innerHTML = `<div class="aix-rev-total"><span class="lbl">累计 AIX 收益</span><span class="val">${money(total)}<small>AIX</small></span></div>${statCard('昨日收益','yesterday')}${statCard('矿机产出','miner')}${statCard('质押收益','stake')}${statCard('直推收益(15%)','direct')}${statCard('间推/级差收益','team')}`;
      return;
    }
    const items = summary.map(s => `<div class="aix-rev-item"><div class="lbl">${s.label}</div><div class="val">${Number(s.amount).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div></div>`).join('');
    host.innerHTML = `<div class="aix-rev-total"><span class="lbl">累计 AIX 收益</span><span class="val">${money(total)}<small>AIX</small></span></div>${statCard('昨日收益','yesterday')}${statCard('矿机产出','miner')}${statCard('质押收益','stake')}${statCard('直推收益(15%)','direct')}${statCard('间推/级差收益','team')}<div class="aix-rev-kind-grid">${items}</div>`;
  }

  function renderRevenueList(data) {
    const host = node('aix-revenue-list');
    if (!host) return;
    const cards = document.getElementById('aix-revenue-cards');
    const list = data.list || [];
    if (!list.length) {
      host.innerHTML = '<tr><td colspan="5" class="account-empty">暂无收益记录</td></tr>';
      if (cards) cards.innerHTML = '<div class="account-empty rec-empty">暂无收益记录</div>';
      return;
    }
    const rows = list.map(r => {
      const parsedTime = Number(r.createdAt);
      const timeValue = Number.isFinite(parsedTime) && parsedTime > 0 ? parsedTime : Date.parse(String(r.createdAt || ''));
      const date = Number.isFinite(timeValue) && timeValue > 0 ? new Date(timeValue) : null;
      const time = date ? date.toLocaleString('zh-CN', { hour12:false, timeZone:'Asia/Shanghai' }) : '—';
      const timeShort = date ? date.toLocaleString('zh-CN', { hour12:false, timeZone:'Asia/Shanghai', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—';
      const label = r.label || r.kind || '—';
      const detail = r.detail || '—';
      const rate = r.rate || '—';
      const amount = `+${Number(r.amount).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})} AIX`;
      return { time, timeShort, label, detail, rate, amount };
    });
    host.innerHTML = rows.map(r => `<tr><td data-label="时间">${r.time}</td><td data-label="类型">${r.label}</td><td data-label="来源">${r.detail}</td><td data-label="比例">${r.rate}</td><td data-label="收益(AIX)" class="up">${r.amount}</td></tr>`).join('');
    if (cards) {
      cards.innerHTML = rows.map(r => {
        const detail = [
          ['来源', r.detail], ['比例', r.rate], ['时间', r.time],
        ].map(([k, v]) => `<div><i>${k}</i><b>${v}</b></div>`).join('');
        return `<div class="rec-card"><div class="rec-head"><span class="rec-type">${r.label}</span><span class="rec-amount up">${r.amount}</span></div><div class="rec-meta"><span>${r.timeShort}</span><span class="rec-open"></span></div><div class="rec-detail">${detail}</div></div>`;
      }).join('') || '<div class="account-empty rec-empty">暂无收益记录</div>';
    }
  }

  async function openFunding(type) {
    try { if (!walletConfig) await loadWalletConfig(); }
    catch (error) { showToast(error.message, 'error'); return; }
    // 提现改为全局 modal 弹窗（与 AIX 提现风格统一），不再走资产页内嵌表单
    if (type === 'withdraw') {
      if (window.USDTWithdrawal?.open) return window.USDTWithdrawal.open();
      // 兜底：modal 未加载时回落到原内嵌表单
    }
    const funding = node('account-funding-forms');
    const dashboard = node('assets-dashboard-view');
    const deposit = node('assets-deposit-panel');
    const withdraw = node('assets-withdraw-panel');
    const target = type === 'withdraw' ? withdraw : deposit;
    const label = type === 'withdraw' ? '提现' : '充值';
    if (dashboard) dashboard.hidden = true;
    if (funding) funding.hidden = false;
    if (deposit) deposit.hidden = type === 'withdraw';
    if (withdraw) withdraw.hidden = type !== 'withdraw';
    setText('assets-funding-title', label);
    setText('assets-funding-breadcrumb', label);
    window.scrollTo({ top:0, behavior:'smooth' });
    setTimeout(() => target?.querySelector('input:not([readonly])')?.focus(), 150);
  }

  function closeFunding() {
    const funding = node('account-funding-forms');
    const dashboard = node('assets-dashboard-view');
    if (funding) funding.hidden = true;
    if (dashboard) dashboard.hidden = false;
    window.scrollTo({ top:0, behavior:'smooth' });
  }

  function openTrade(symbol) {
    if (typeof openTradePage === 'function') openTradePage('spot', symbol);
  }

  let refreshRequest = null, refreshWallet = '';
  function refresh() {
    const key = window.Portal?.walletKey();
    if (refreshRequest && refreshWallet === key) return refreshRequest;
    refreshWallet = key;
    const promise = refreshData();
    refreshRequest = promise;
    promise.finally(() => { if (refreshRequest === promise) refreshRequest = null; }).catch(() => {});
    return promise;
  }
  async function refreshData() {
    const refreshButton = document.querySelector('.assets-icon-btn');
    if (refreshButton) refreshButton.disabled = true;
    try {
      // The authenticated wallet and platform sections can update independently.
      if (window.currentWalletProfile?.authenticated) {
        renderWallet(window.currentWalletProfile);
        await Promise.allSettled([loadWalletProfile(), loadPlatformProfile()]);
        return;
      }
      if (typeof loadWalletProfile === 'function') await loadWalletProfile();
      if (!window.currentWalletProfile?.authenticated && window.currentWalletConnection?.address
        && typeof ensurePlatformSession === 'function') await ensurePlatformSession(refreshButton);
      if (window.currentWalletProfile?.authenticated && typeof loadPlatformProfile === 'function') await loadPlatformProfile();
    } finally {
      if (refreshButton) refreshButton.disabled = false;
    }
  }

  function activate() {
    closeFunding();
    setView('balances');
    refresh().catch(error => console.error('[assets]', error));
  }

  async function openAix(type, button) {
    if (button) button.disabled = true;
    try {
      await window.loadPageFeature(`a-token-${type}`);
      await (type === 'transfer' ? window.ATokenTransfer : window.ATokenWithdrawal).open();
    } catch (error) { showToast(error.message, 'error'); }
    finally { if (button) button.disabled = false; }
  }
  window.ExchangeAssets = { activate, closeFunding, openFunding, openAix, openTrade, refresh, renderAssets, renderPlatform, renderWallet, setView };
})();
