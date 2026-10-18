// ══════════════════════════════════════════════════════════════════════════════
// 各交易所控制逻辑（工厂函数）
// ══════════════════════════════════════════════════════════════════════════════
function modeLabel(mode) {
  return mode === 'long' ? '做多' : mode === 'short' ? '做空' : '中性';
}

function makeExchangeCtrl(prefix, chartId) {
  const strategyApi = `/api/internal-strategy/${prefix}`;
  const strategyLabel = { de:'策略 1', ex:'策略 2', rs:'策略 3' }[prefix];
  let selectedMode = 'neutral';
  let riskProfile = (() => {
    try {
      const saved = localStorage.getItem(`grid-risk-profile-${prefix}`);
      return saved === 'aggressive' ? 'aggressive' : 'steady';
    } catch { return 'steady'; }
  })();
  let markets = [];
  let curTrend = null;
  let lastState = null;
  let chart = null;
  let candleSeries = null;
  let gridPriceLines = [];
  let chartResizeObserver = null;
  let chartNeedsFit = true;
  let appliedConfigSignature = null;
  let trendRefreshInFlight = false;
  let initialized = false;
  let platformAvailable = 0;
  let latestCandles = [], chartLoading = null;
  let walletGeneration = 0;
  const dirtyFields = new Set();

  window.addEventListener('wg-theme-change', event => {
    if (chart) chart.applyOptions(window.WGTheme?.chartOptions?.(event.detail?.theme) || {});
  });

  const P = (suf) => $(prefix + '-' + suf);

  function normalizeNumberText(value) {
    return String(value ?? '')
      .trim()
      .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xFF10))
      .replace(/[，,]/g, '.')
      .replace(/。/g, '.');
  }

  function readNumber(suffix) {
    const field = P(suffix);
    const value = Number(normalizeNumberText(field.value));
    const valid = Number.isFinite(value) && value > 0;
    field.classList.toggle('invalid', field.value.trim() !== '' && !valid);
    return valid ? value : NaN;
  }

  function bindBoundaryInput(suffix) {
    const field = P(suffix);
    field.addEventListener('input', () => {
      dirtyFields.add(suffix);
      readNumber(suffix);
      calculateGridSettings();
      updateRiskPreview();
    });
    field.addEventListener('blur', () => {
      const normalized = normalizeNumberText(field.value);
      if (normalized && Number.isFinite(Number(normalized))) field.value = normalized;
      readNumber(suffix);
      calculateGridSettings();
      updateRiskPreview();
    });
  }

  function syncChoicePicker(suffix, disabled = P(suffix).disabled) {
    const select = P(suffix);
    const picker = P(`${suffix}-picker`);
    if (!select || !picker) return;
    picker.querySelectorAll('.choice-option').forEach((button) => {
      const selected = button.dataset.value === select.value;
      button.classList.toggle('sel', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.disabled = disabled;
    });
  }

  function rebuildChoicePicker(suffix) {
    const select = P(suffix);
    const picker = P(`${suffix}-picker`);
    if (!select || !picker) return;
    picker.replaceChildren(...[...select.options].map((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'choice-option';
      button.dataset.value = option.value;
      button.textContent = option.textContent;
      button.onclick = () => {
        if (button.disabled || select.value === option.value) return;
        select.value = option.value;
        syncChoicePicker(suffix);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      return button;
    }));
    syncChoicePicker(suffix);
  }

  function selectedMarketPrice(state = lastState, fallbackPrice = null) {
    const marketId = String(P('market').value || '');
    const market = markets.find((item) => String(item.marketId) === marketId);
    const streamedPrice = Number(state?.marketPrices?.[marketId]);
    const configuredPrice = String(state?.config?.marketId ?? '') === marketId ? Number(state?.lastPrice) : NaN;
    const initialPrice = Number(fallbackPrice ?? market?.lastPrice);
    return streamedPrice > 0 ? streamedPrice : configuredPrice > 0 ? configuredPrice : initialPrice;
  }

  function renderLiveMarketPrice(state = lastState, fallbackPrice = null) {
    if (!P('chart-price-symbol') || !P('chart-price-value') || !P('chart-price')) return;
    const marketId = String(P('market').value || '');
    const market = markets.find((item) => String(item.marketId) === marketId);
    const price = selectedMarketPrice(state, fallbackPrice);
    const symbol = market?.publicSymbol
      ? String(market.publicSymbol).replace(/USDT$/, '/USDT')
      : market?.displayName || '—';

    P('chart-price-symbol').textContent = symbol;
    P('chart-price-value').textContent = fmtMarketPrice(price);
    P('chart-price').classList.toggle('is-unavailable', !(price > 0));
  }

  // mode buttons
  P('modes').querySelectorAll('.mode-btn').forEach(b => b.onclick = () => {
    if (lastState?.running) return;
    dirtyFields.add('mode');
    setMode(b.dataset.mode);
  });
  setMode('neutral');

  // risk toggle
  P('risk-toggle').querySelectorAll('.risk-btn').forEach(b => b.onclick = () => {
    P('risk-toggle').querySelectorAll('.risk-btn').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel'); riskProfile = b.dataset.risk;
    try { localStorage.setItem(`grid-risk-profile-${prefix}`, riskProfile); } catch { /* optional preference */ }
    P('risk-hint').textContent = RISK[riskProfile].hint;
    if (curTrend?.price) applyStrategyByRisk();
  });
  P('risk-toggle').querySelectorAll('.risk-btn').forEach(b => b.classList.toggle('sel', b.dataset.risk === riskProfile));
  P('risk-hint').textContent = RISK[riskProfile].hint;

  function configSignature(config) {
    if (!config) return null;
    return JSON.stringify([
      config.marketId, config.mode, config.lower, config.upper, config.gridCount,
      config.sizeBase, config.leverage, config.outOfRangeAction,
    ]);
  }

  function syncFormFromConfig(config, { force = false } = {}) {
    const signature = configSignature(config);
    if (!signature || (!force && signature === appliedConfigSignature)) return false;

    const marketId = String(config.marketId ?? '');
    if ([...P('market').options].some((option) => option.value === marketId)) P('market').value = marketId;
    syncChoicePicker('market');
    if (['neutral', 'long', 'short'].includes(config.mode) && !dirtyFields.has('mode')) setMode(config.mode);
    if (config.lower != null && (force || !dirtyFields.has('lower'))) P('lower').value = config.lower;
    if (config.upper != null && (force || !dirtyFields.has('upper'))) P('upper').value = config.upper;
    if (config.gridCount != null && (force || !dirtyFields.has('grid-count'))) P('grid-count').value = config.gridCount;
    if (config.sizeBase != null && (force || !dirtyFields.has('size-base'))) P('size-base').value = config.sizeBase;
    if (config.leverage != null && (force || !dirtyFields.has('leverage'))) P('leverage').value = config.leverage;
    if (config.outOfRangeAction && [...P('auto-stop').options].some((option) => option.value === config.outOfRangeAction)) {
      if (force || !dirtyFields.has('auto-stop')) P('auto-stop').value = config.outOfRangeAction;
    }
    appliedConfigSignature = signature;
    updateRiskPreview();
    return true;
  }

  function sizeByBalance() {
    const p = lastState?.lastPrice || curTrend?.price;
    if (p) autoSizePerGrid(p, +P('leverage').value || 3);
  }

  async function loadMarkets() {
    try {
      const j = await Portal.readJSON(`${strategyApi}/markets`);
      if (!Portal.active(prefix)) { initialized = false; return; }
      markets = j.markets;
      // Update header badge
      const hdrBadge = $('hdr-' + prefix);
      hdrBadge.textContent = prefix.toUpperCase() + ': ' + j.mode.toUpperCase();
      hdrBadge.className = 'badge ' + (j.mode === 'live' ? 'badge-live' : 'badge-paper');

      P('market').innerHTML = markets.map(m => `<option value="${m.marketId}">${m.displayName}</option>`).join('');
      rebuildChoicePicker('market');
      const restored = syncFormFromConfig(lastState?.config, { force: true });
      if (!restored && markets[0]) P('size-base').value = markets[0].minOrderSize || 0.001;
      renderLiveMarketPrice(lastState);
      // Account funds and market analysis render independently.
      await Promise.allSettled([refreshTrend(), refreshPlatformBalance()]);
    } catch (e) {
      initialized = false;
      console.error(`[${prefix}] loadMarkets failed:`, e.message);
    }
  }

  async function refreshPlatformBalance() {
    const wallet = Portal.walletKey(), generation = walletGeneration;
    try {
      const profile = await PlatformClient.profile(P('market').value || 'BTC');
      if (wallet !== Portal.walletKey() || generation !== walletGeneration) return;
      platformAvailable = Number(profile?.account?.availableMargin ?? profile?.account?.availableBalance ?? 0);
      P('capital').value = platformAvailable > 0 ? platformAvailable.toFixed(6) : '0';
      const balanceNode = P('capital-available');
      if (balanceNode) balanceNode.textContent = platformAvailable > 0 ? `${platformAvailable.toLocaleString('en-US', { maximumFractionDigits:6 })} USDT` : '0 USDT';
      calculateGridSettings();
    } catch {
      if (wallet !== Portal.walletKey() || generation !== walletGeneration) return;
      platformAvailable = 0;
      const balanceNode = P('capital-available');
      if (balanceNode) balanceNode.textContent = '请先连接钱包';
    }
  }

  async function refreshTrend({ silent = false } = {}) {
    if (trendRefreshInFlight && silent) return;
    trendRefreshInFlight = true;
    const marketId = P('market').value;
    if (!silent) P('rec-tag').textContent = '分析中…';
    try {
      const interval = P('interval').value;
      const j = await Portal.readJSON(`${strategyApi}/trend?marketId=${marketId}&intervalSec=${interval}`);
      if (!Portal.active(prefix) || marketId !== P('market').value || interval !== P('interval').value) return;
      if (j.error) throw new Error(j.error);
      curTrend = j.analysis;
      renderTrend(j.analysis);
      renderLiveMarketPrice(lastState, j.analysis?.price);
      drawChart(j.candles || []);
      if (!P('lower').value) applyAutoRange();
      calculateGridSettings();
    } catch (e) {
      if (!silent) {
        P('rec-tag').textContent = '趋势数据暂不可用';
        P('rec-detail').textContent = '手动填上下边界即可启动。(' + e.message + ')';
      }
    } finally { trendRefreshInFlight = false; }
  }

  function renderTrend(a) {
    const map = { up: ['上升趋势 ↗','rec-up','做多'], down: ['下降趋势 ↘','rec-down','做空'], range: ['震荡 ↔','rec-range','中性'] };
    const [txt, cls2] = map[a.trend];
    P('rec-box').className = 'rec-box ' + cls2;
    P('rec-tag').innerHTML = `${txt} <span class="muted" style="font-size:11px">推荐：${map[a.trend][2]}网格 · 强度 ${(a.strength*100).toFixed(0)}%</span>`;
    P('rec-detail').textContent = a.detail;
    P('modes').querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('rec', b.dataset.mode === a.recommended));
  }

  P('apply-rec').onclick = () => {
    if (!curTrend) return;
    dirtyFields.add('mode');
    setMode(curTrend.recommended || 'neutral');
    applyAutoRange(); updateRiskPreview();
  };

  P('smart-fill').onclick = async () => {
    const btn = P('smart-fill'); const old = btn.textContent;
    btn.disabled = true; btn.textContent = '分析行情中...';
    try {
      await refreshTrend();
      if (!curTrend?.price) { P('smart-note').textContent = '无法获取行情，请稍后重试。'; return; }
      dirtyFields.add('mode');
      setMode(curTrend.recommended || 'neutral');
      applyStrategyByRisk();
    } catch (e) {
      P('smart-note').textContent = '智能填充失败：' + e.message;
    } finally { btn.disabled = false; btn.textContent = old; }
  };

  function applyStrategyByRisk() {
    if (!curTrend?.price) return;
    const r = RISK[riskProfile];
    applyAutoRange();
    const atrPct = curTrend.atrPct || 0.8;
    const targetSpacingPct = Math.min(r.sMax, Math.max(r.sMin, atrPct * r.sMul));
    const lo = readNumber('lower'), hi = readNumber('upper'), p = curTrend.price;
    let n = Math.round(((hi-lo)/p*100)/targetSpacingPct);
    n = Math.min(200, Math.max(10, n));
    P('grid-count').value = n;
    const lev = atrPct > 3 ? r.lev.hi : atrPct > 1.5 ? r.lev.mid : r.lev.lo;
    P('leverage').value = lev;
    autoSizePerGrid(p, lev);
    updateRiskPreview();
    const modeTxt = curTrend.recommended === 'long' ? '做多' : curTrend.recommended === 'short' ? '做空' : '中性';
    P('smart-note').innerHTML = `✅ [${riskProfile === 'aggressive' ? '激进' : '稳健'}] <b>${modeTxt}网格</b> · ${P('grid-count').value} 格 · ${P('leverage').value}x`;
  }

  function setMode(mode) {
    P('modes').querySelectorAll('.mode-btn').forEach(b => {
      const sel = b.dataset.mode === mode;
      b.classList.toggle('sel', sel);
      b.setAttribute('aria-pressed', String(sel));
      if (sel) selectedMode = mode;
    });
    P('start-btn').textContent = `启动${modeLabel(selectedMode)}策略`;
  }

  function renderStrategySummary(summary) {
    const states = summary?.strategies || {};
    document.querySelectorAll('[data-strategy-key]').forEach((button) => {
      const state = states[button.dataset.strategyKey];
      const label = button.dataset.strategyLabel || button.textContent;
      button.textContent = state?.running ? `${label} · ${modeLabel(state.config?.mode)}运行中` : label;
      button.classList.toggle('strategy-running', Boolean(state?.running));
    });
    document.querySelectorAll('[data-strategy-overview]').forEach((node) => {
      node.textContent = `运行中 ${summary?.runningCount || 0} / ${summary?.maxRunning || 3} · 每个策略独立选择投入金额和方向`;
    });
  }

  async function refreshStrategySummary() {
    try {
      const response = await fetch('/api/internal-strategy/summary');
      if (response.ok) renderStrategySummary(await response.json());
    } catch { /* 状态流仍会继续更新当前策略 */ }
  }

  function calculateGridSettings() {
    const price = Number(lastState?.lastPrice || curTrend?.price);
    const size = Number(P('size-base').value);
    if (!(price > 0) || !(size > 0)) return;
    const count = Math.trunc(Number(P('grid-count').value));
    const lev = Number(P('leverage').value);
    if (!Number.isInteger(count) || count < 2 || !Number.isSafeInteger(lev) || lev < 1) return;
    const lower = readNumber('lower'), upper = readNumber('upper');
    const midpoint = upper > lower ? (lower + upper) / 2 : price;
    const required = count * size * midpoint / lev;
    P('capital').value = required > 0 ? required.toFixed(6) : '0';
  }

  function autoSizePerGrid(price, lev) {
    calculateGridSettings();
    updateRiskPreview();
  }

  function applyAutoRange() {
    if (!curTrend?.price) return;
    const p = curTrend.price;
    const atr = curTrend.atrPct || 0.8;
    const r = RISK[riskProfile];
    const halfPct = Math.min(r.rMax, Math.max(r.rMin, (atr/100)*r.rMul));
    let lo = p*(1-halfPct), hi = p*(1+halfPct);
    if (selectedMode === 'long')  { hi = p*(1+halfPct*r.skew); lo = p*(1-halfPct*(2-r.skew)); }
    if (selectedMode === 'short') { lo = p*(1-halfPct*r.skew); hi = p*(1+halfPct*(2-r.skew)); }
    P('lower').value = +lo.toPrecision(6); P('upper').value = +hi.toPrecision(6);
    dirtyFields.add('lower'); dirtyFields.add('upper');
    updateRiskPreview();
  }

  function updateRiskPreview() {
    const editableFields = ['lower', 'upper', 'grid-count', 'size-base', 'leverage', 'auto-stop'];
    const pendingAdjust = editableFields.some(field => dirtyFields.has(field));
    const runningConfig = lastState?.running && lastState.config && !pendingAdjust ? lastState.config : null;
    const lo = runningConfig ? Number(runningConfig.lower) : readNumber('lower');
    const hi = runningConfig ? Number(runningConfig.upper) : readNumber('upper');
    const n = runningConfig ? Number(runningConfig.gridCount) : +P('grid-count').value;
    const sz = runningConfig ? Number(runningConfig.sizeBase) : +P('size-base').value;
    const lev = runningConfig ? Number(runningConfig.leverage) : +P('leverage').value;
    if (!(hi > lo) || !n || !sz) { P('risk-preview').textContent = ''; drawGridOverlay(); return; }
    const mid = (lo+hi)/2, spacing = (hi-lo)/n;
    const notional = n*sz*mid, margin = notional/lev;
    const title = runningConfig ? '当前运行参数：' : (lastState?.running ? '待调整预览：' : '');
    P('risk-preview').innerHTML = `${title}单格间距 <b>${spacing.toPrecision(4)}</b>（${(spacing/mid*100).toFixed(2)}%）· 每格毛利 <b>${(spacing*sz).toPrecision(3)}</b><br>预计占用 <b>${margin.toFixed(2)}</b> USDT · 可用 <b>${platformAvailable.toFixed(2)}</b> USDT（${lev}x）`;
    drawGridOverlay();
  }

  function plannedSeedOrderCount(body, price) {
    if (!(price > 0) || !Number.isInteger(body.gridCount) || body.gridCount < 2 || !(body.upper > body.lower)) return null;
    const spacing = (body.upper - body.lower) / body.gridCount;
    const band = spacing * 0.25;
    let count = 0;
    for (let index = 0; index <= body.gridCount; index += 1) {
      const level = body.lower + index * spacing;
      if (Math.abs(level - price) < band) continue;
      if (level < price && (body.mode === 'neutral' || body.mode === 'long')) count += 1;
      if (level > price && (body.mode === 'neutral' || body.mode === 'short')) count += 1;
    }
    return count;
  }

  bindBoundaryInput('lower');
  bindBoundaryInput('upper');
  ['grid-count','size-base','leverage'].forEach(id => P(id).addEventListener('input', () => { dirtyFields.add(id); calculateGridSettings(); updateRiskPreview(); }));
  P('auto-stop').addEventListener('change', () => { dirtyFields.add('auto-stop'); updateRiskPreview(); });
  ['grid-count','leverage'].forEach(id => P(id).addEventListener('change', sizeByBalance));

  P('start-btn').onclick = async () => {
    const body = {
      marketId: P('market').value, mode: selectedMode,
      lower: readNumber('lower'), upper: readNumber('upper'),
      gridCount: +P('grid-count').value, sizeBase: +P('size-base').value,
      leverage: +P('leverage').value, capital: +P('capital').value, outOfRangeAction: P('auto-stop').value,
    };
    if (!Number.isInteger(body.gridCount) || body.gridCount < 2 || body.gridCount > 500) {
      alert('网格数量必须是 2–500 之间的整数。'); return;
    }
    if (!(body.sizeBase > 0)) { alert('每格数量必须大于 0。'); return; }
    if (!(body.capital > 0)) { alert('平台可用 USDT 不足，无法启动策略。'); return; }
    if (platformAvailable > 0 && body.capital > platformAvailable) { alert(`本次网格预计需要 ${body.capital.toFixed(2)} USDT，但平台可用余额只有 ${platformAvailable.toFixed(2)} USDT。`); return; }
    if (!Number.isSafeInteger(body.leverage) || body.leverage < 1) { alert('杠杆必须为大于等于 1 的整数。'); return; }
    if (!(body.upper > body.lower)) { alert('请填写有效的上下边界，并确保上边界大于下边界。'); return; }
    const livePrice = selectedMarketPrice(lastState, curTrend?.price);
    const planned = plannedSeedOrderCount(body, livePrice);
    const source = lastState?.health?.priceTransport === 'websocket' ? 'WebSocket 实时价'
      : lastState?.health?.dataSource === 'real' ? 'REST 实时价' : '合成行情';
    const confirmed = await confirmDialog(
      `确认启动${strategyLabel}？\n\n`
      + `方向：${modeLabel(body.mode)}\n`
      + `预计占用：${body.capital} USDT（从平台可用余额扣除）\n`
      + `网格：${body.gridCount} 格（${body.gridCount + 1} 条价格线）\n`
      + `预计初始挂单：${planned ?? '待后端计算'} 单\n`
      + `每单数量：${body.sizeBase} 币\n`
      + `当前价：${fmtMarketPrice(livePrice)}（${source}）`
    );
    if (!confirmed) return;
    await ensurePlatformSession();
    const r = await fetch(`${strategyApi}/start`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    const j = await r.json();
    if (j.error) { alert('启动失败：' + j.error); return; }
    const audit = j.orderAudit;
    if (!audit?.ok || j.config?.gridCount !== body.gridCount || j.config?.sizeBase !== body.sizeBase) {
      alert(`启动对账警告：提交 ${body.gridCount} 格 × ${body.sizeBase} 币；后端保存 ${j.config?.gridCount} 格 × ${j.config?.sizeBase} 币；计划 ${audit?.plannedOrders ?? '—'} 单，成功 ${audit?.startupPlacedOrders ?? '—'} 单。`);
    }
    dirtyFields.clear();
    render(j);
    refreshStrategySummary();
    refreshPlatformBalance();
  };

  P('stop-btn').onclick = async () => {
    const button = P('stop-btn');
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '结算中…';
    try {
      await ensurePlatformSession(button);
      const response = await fetch(`${strategyApi}/stop`, {
        method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:'{}',
      });
      const state = await response.json().catch(() => ({}));
      if (!response.ok || state.error) throw new Error(state.error || `停止请求失败（${response.status}）`);
      if (state.running) throw new Error('平台未确认策略停止，请重试');
      render(state);
      refreshStrategySummary();
      await Promise.all([
        refreshPlatformBalance(),
        typeof loadWalletProfile === 'function' ? loadWalletProfile() : Promise.resolve(),
      ]);
      window.InternalStrategyOverview?.activate?.();
      if (typeof showToast === 'function') showToast(`策略已停止，${state.equity || '0'} USDT 已结算到平台可用余额`);
    } catch (error) {
      const message = error?.message || '停止结算失败';
      if (typeof showToast === 'function') showToast(message, 'error');
      else alert(`停止失败：${message}`);
    } finally {
      button.textContent = originalText;
      button.disabled = !lastState?.running;
    }
  };

  P('adjust-btn').onclick = async () => {
    const lower = readNumber('lower'), upper = readNumber('upper');
    if (!(upper > lower)) { alert('请先填写有效的上/下边界'); return; }
    if (!await confirmDialog(`确认将运行中的网格区间调整为 [${lower}, ${upper}]？\n会撤销现有挂单并按新区间重新挂单（持仓保留、网格不停止）。`)) return;
    const gridCount = Math.trunc(Number(P('grid-count').value));
    const sizeBase = Number(P('size-base').value);
    const leverage = Math.trunc(Number(P('leverage').value));
    const outOfRangeAction = P('auto-stop').value;
    if (!Number.isInteger(gridCount) || gridCount < 2 || gridCount > 500 || !(sizeBase > 0) || !Number.isSafeInteger(leverage) || leverage < 1) {
      alert('请输入有效的网格数量（2-500）、每格数量和杠杆'); return;
    }
    const r = await fetch(`${strategyApi}/adjust`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ lower, upper, gridCount, sizeBase, leverage, outOfRangeAction }) });
    const j = await r.json();
    if (j.error) alert('调整失败：' + j.error);
    else { ['lower', 'upper', 'grid-count', 'size-base', 'leverage', 'auto-stop'].forEach(field => dirtyFields.delete(field)); render(j); }
  };

  if (P('reconnect-btn')) P('reconnect-btn').onclick = async () => {
    try {
      await ensurePlatformSession();
      if (!es || es.readyState === EventSource.CLOSED) connectStateStream();
      if (lastState) render(lastState);
    } catch (error) {
      if (typeof showToast === 'function') showToast(error.message || '请先连接钱包', 'error');
    }
  };

  P('market').onchange = () => {
    syncChoicePicker('market');
    renderLiveMarketPrice(lastState);
    chartNeedsFit = true;
    refreshTrend();
    refreshPlatformBalance();
  };
  P('interval').onchange = () => {
    syncChoicePicker('interval');
    refreshTrend();
  };
  P('refresh-trend').onclick = () => refreshTrend();
  rebuildChoicePicker('interval');

  // SSE
  let es = null;
  function connectStateStream() {
    es?.close();
    es = new EventSource(`${strategyApi}/stream`);
    es.onmessage = (event) => {
      const state = JSON.parse(event.data);
      if ($('tab-' + prefix).classList.contains('active')) render(state);
      else lastState = state;
    };
  }
  function resetForWallet() {
    ++walletGeneration; platformAvailable = 0;
    es?.close(); es = null; lastState = null;
    P('st-run').innerHTML = '<span class="badge badge-stop">连接钱包后查看</span>';
    P('fills').innerHTML = '<tr><td class="empty-row" colspan="7">暂无成交</td></tr>';
  }

  function applyFastPrice(update) {
    if (!lastState) lastState = { marketPrices: {} };
    if (!lastState.marketPrices) lastState.marketPrices = {};
    if (update.marketId && Number(update.price) > 0) {
      lastState.marketPrices[String(update.marketId)] = Number(update.price);
      if (String(lastState.config?.marketId ?? '') === String(update.marketId)) {
        lastState.lastPrice = Number(update.price);
      }
      if (String(P('market').value || '') === String(update.marketId)) {
        P('st-price').textContent = fmtMarketPrice(update.price);
      }
    }
    renderLiveMarketPrice(lastState);
  }

  function render(s) {
    if (s.exchange && s.exchange !== prefix) {
      console.error(`[${prefix}] ignored state for ${s.exchange}`);
      return;
    }
    lastState = s;
    const editableFields = ['lower', 'upper', 'grid-count', 'size-base', 'leverage', 'auto-stop'];
    const hasPendingAdjust = editableFields.some(field => dirtyFields.has(field));
    syncFormFromConfig(s.config, { force: Boolean(s.running) && !hasPendingAdjust });
    const run = s.running;
    P('start-btn').disabled = run;
    P('stop-btn').disabled = !run;
    if (P('adjust-btn')) P('adjust-btn').disabled = !run;
    P('market').disabled = run;
    P('capital').disabled = run;
    ['grid-count','size-base','leverage','lower','upper','auto-stop'].forEach((field) => { P(field).disabled = false; });
    syncChoicePicker('market', run);
    P('market-lock-note').textContent = run ? '网格运行中，停止后可切换交易对' : '';
    syncChoicePicker('interval', false);
    P('smart-fill').disabled = run;
    P('apply-rec').disabled = run;
    P('modes').querySelectorAll('.mode-btn').forEach((button) => { button.disabled = run; });
    P('mode-lock-note').textContent = run ? '网格运行中，停止后可切换中性 / 做多 / 做空' : '';
    P('st-run').innerHTML = run ? `<span class="badge badge-run">运行中（${modeLabel(s.config?.mode)}）</span>` : '<span class="badge badge-stop">未运行</span>';
    P('st-price').textContent = fmtMarketPrice(selectedMarketPrice(s, curTrend?.price));
    renderLiveMarketPrice(s, curTrend?.price);
    P('st-bal').textContent = s.capital ?? '—';
    P('st-eq').textContent = s.equity ?? '—';

    if (s.position) {
      const long = s.position.sizeBase > 0;
      const levTxt = s.position.leverage ? ` <span class="muted">@${s.position.leverage}x</span>` : '';
      P('st-pos').innerHTML = `<span class="${long?'up':'down'}">${long?'多':'空'} ${Math.abs(s.position.sizeBase)}</span>${levTxt}`;
      P('st-entry').textContent = s.position.entryPrice || '—';
      P('st-upnl').innerHTML = pnlHtml(s.position.unrealizedPnl);
    } else {
      P('st-pos').textContent = '无持仓';
      P('st-entry').textContent = '—';
      P('st-upnl').textContent = '—';
    }
    P('st-rpnl').innerHTML = pnlHtml(s.realizedPnl);
    P('st-total').innerHTML = `${pnlHtml(s.totalPnl)} <span class="muted">/ ${s.returnPct != null ? `<span class="${cls(s.returnPct)}">${s.returnPct>=0?'+':''}${s.returnPct}%</span>` : '—'}</span>`;
    const audit = s.orderAudit;
    if (audit) {
      const sizeText = audit.trackedSizeMin == null ? '—'
        : audit.trackedSizeMin === audit.trackedSizeMax ? audit.trackedSizeMin
        : `${audit.trackedSizeMin}–${audit.trackedSizeMax}`;
      P('st-orders').textContent = `配置 ${audit.configuredGridCount ?? '—'} 格 × ${audit.configuredSizeBase ?? '—'} 币 · 计划 ${audit.plannedOrders ?? '—'} 单 · 跟踪 ${audit.trackedOrders} / 交易所 ${audit.exchangeOrders ?? '—'} 单 · 实挂币量 ${sizeText}`;
      P('st-orders').className = `val ${audit.ok ? '' : 'down'}`;
    } else {
      P('st-orders').textContent = `${s.openOrders ?? 0} 单 / ${s.stats?.completedRungs ?? 0} 格`;
    }

    P('fills').innerHTML = renderFills(s.fills);
    P('alerts').innerHTML = (s.alerts||[]).map(a => `<div class="log-item">${new Date(a.t).toLocaleTimeString()} · ${a.message}</div>`).join('') || '<div class="log-item muted">暂无日志</div>';
    P('range-warn').innerHTML = s.outOfRange ? `<div class="warn-box">⚠️ 价格已脱离网格区间，已暂停区间外补单。</div>` : '';

    if (s.config) drawGridOverlay(s);
  }

  function drawChart(candles) {
    latestCandles = candles;
    if (typeof LightweightCharts === 'undefined') {
      if (!chartLoading && Portal.active(prefix)) {
        chartLoading = window.loadPageCharts?.();
        chartLoading?.then(() => { if (Portal.active(prefix)) drawChart(latestCandles); }).catch(() => {}).finally(() => { chartLoading = null; });
      }
      return;
    }
    if (!Portal.active(prefix)) return;
    const container = $(chartId);
    if (!container || !Array.isArray(candles)) return;
    const data = candles.map(candle => ({
      time:Math.floor(Number(candle.time) / 1000),
      open:Number(candle.open), high:Number(candle.high), low:Number(candle.low), close:Number(candle.close),
    })).filter(candle => Number.isFinite(candle.time) && Number.isFinite(candle.open) && Number.isFinite(candle.close));
    if (!data.length) return;
    if (!chart) {
      const theme = window.WGTheme?.chartOptions?.() || {
        layout:{ background:{ type:'solid', color:'#0b0f0e' }, textColor:'#91a19b' },
        grid:{ vertLines:{ color:'#19211f' }, horzLines:{ color:'#19211f' } },
        rightPriceScale:{ borderColor:'#202a27' }, timeScale:{ borderColor:'#202a27' },
      };
      const tzOpts = (typeof window.wgChartTzOptions === 'function') ? window.wgChartTzOptions() : { localization:{}, timeScale:{} };
      chart = LightweightCharts.createChart(container, {
        width: container?.clientWidth || 600,
        height: container?.clientHeight || 300,
        layout:{ ...theme.layout, fontFamily:'-apple-system, Segoe UI, sans-serif' },
        grid:theme.grid,
        crosshair:{ mode:LightweightCharts.CrosshairMode.Normal },
        rightPriceScale:{ ...theme.rightPriceScale, scaleMargins:{ top:0.08, bottom:0.08 } },
        timeScale:{ ...theme.timeScale, ...tzOpts.timeScale, timeVisible:true, secondsVisible:false, rightOffset:4, barSpacing:7, fixLeftEdge:true },
        localization:{ locale:'zh-CN', ...tzOpts.localization },
      });
      // 手动接管尺寸同步：autoSize 在 iOS / 窄屏容器下测量不准
      const fitStrategyChart = () => {
        if (!chart) return;
        const w = container?.clientWidth || 0;
        const h = container?.clientHeight || 300;
        if (w > 0) chart.applyOptions({ width:w, height:h });
      };
      if (window.ResizeObserver && container) {
        chartResizeObserver = new ResizeObserver(fitStrategyChart);
        chartResizeObserver.observe(container);
      }
      window.addEventListener('resize', fitStrategyChart);
      window.visualViewport?.addEventListener?.('resize', fitStrategyChart);
      fitStrategyChart();
      candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
        upColor:'#4fd1b5', downColor:'#f06f75', borderVisible:false, wickUpColor:'#4fd1b5', wickDownColor:'#f06f75',
      });
    }
    candleSeries.setData(data);
    // tab 从 hidden 切到 active 时 clientWidth 可能从 0 变成实际值，强制重新测量 + fit
    const w = container?.clientWidth || 0;
    const h = container?.clientHeight || 390;
    if (w > 0) chart.applyOptions({ width:w, height:h });
    chart.timeScale().fitContent();
    drawGridOverlay(lastState);
  }

  function drawGridOverlay(state = lastState) {
    if (!candleSeries) return;
    for (const line of gridPriceLines) {
      try { candleSeries.removePriceLine(line); } catch { /* chart may have been rebuilt */ }
    }
    gridPriceLines = [];
    const editableFields = ['lower', 'upper', 'grid-count', 'size-base', 'leverage', 'auto-stop'];
    const config = state?.running && state?.config && !editableFields.some(field => dirtyFields.has(field)) ? state.config : {
      lower:readNumber('lower'), upper:readNumber('upper'), gridCount:Number(P('grid-count').value), mode:selectedMode,
    };
    const lower = Number(config.lower), upper = Number(config.upper), count = Math.trunc(Number(config.gridCount));
    if (!(upper > lower) || count < 2) return;
    const color = config.mode === 'long' ? '#4fd1b5' : config.mode === 'short' ? '#f06f75' : '#69a7ff';
    const stride = Math.max(1, Math.ceil(count / 30));
    for (let index = 0; index <= count; index += stride) {
      const boundary = index === 0 || index >= count;
      const price = index >= count ? upper : lower + (upper - lower) * index / count;
      gridPriceLines.push(candleSeries.createPriceLine({
        price, color:boundary ? '#e8c36a' : `${color}55`, lineWidth:boundary ? 2 : 1,
        lineStyle:boundary ? LightweightCharts.LineStyle.Solid : LightweightCharts.LineStyle.Dotted,
        axisLabelVisible:boundary, title:boundary ? (index === 0 ? '下界' : '上界') : '',
      }));
    }
  }

  async function refreshCandles() {
    const marketId = P('market')?.value;
    const interval = P('interval')?.value || 3600;
    if (!marketId) return;
    try {
      const j = await Portal.readJSON(`${strategyApi}/trend?marketId=${marketId}&intervalSec=${interval}`);
      if (!Portal.active(prefix) || marketId !== P('market').value) return;
      if (Array.isArray(j.candles) && j.candles.length) drawChart(j.candles);
    } catch (error) {
      console.error(`[${prefix}] candle refresh failed:`, error.message);
    }
  }

  async function activate() {
    if (!Portal.active(prefix)) return;
    const wallet = Portal.walletKey();
    try {
      await ensurePlatformSession();
    } catch (error) {
      if (typeof showToast === 'function') showToast(error.message || '请先连接钱包', 'error');
      return;
    }
    if (!Portal.active(prefix) || wallet !== Portal.walletKey()) return;
    if (!es || es.readyState === EventSource.CLOSED) connectStateStream();
    if (lastState) render(lastState);
    if (!initialized) {
      initialized = true;
      await loadMarkets();
    } else {
      refreshPlatformBalance();
      refreshTrend({ silent:true });
    }
    // The strategy's own stream carries its state; the all-strategy summary is for overview.

  }
  setInterval(() => {
    if (!document.hidden && P('market').offsetParent !== null) refreshTrend({ silent: true });
  }, 60_000);
  function deactivate() { es?.close(); es = null; }
  return { deactivate, getLastState: () => lastState, applyFastPrice, refreshTrend, refreshCandles, activate, resetForWallet };
}

// ── 初始化三个交易所控制器 ──────────────────────────────────────────────────
const deCtrl = makeExchangeCtrl('de', 'de-chart');
const exCtrl = makeExchangeCtrl('ex', 'ex-chart');
const rsCtrl = makeExchangeCtrl('rs', 'rs-chart');
const exchangeCtrls = { de: deCtrl, ex: exCtrl, rs: rsCtrl };
window.exchangeCtrls = exchangeCtrls;
window.resetInternalStrategiesForWallet = () => {
  Object.values(exchangeCtrls).forEach(ctrl => ctrl.resetForWallet());
  ++strategyOverviewGeneration; strategyOverviewPayload = null; strategyOverviewRequest = null;
  renderInternalStrategyUnavailable('请先连接钱包');
};
window.addEventListener('pagechange', event => {
  for (const [name, ctrl] of Object.entries(exchangeCtrls)) if (name !== event.detail.current) ctrl.deactivate();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) Object.values(exchangeCtrls).forEach(ctrl => ctrl.deactivate());
  else for (const [name, ctrl] of Object.entries(exchangeCtrls)) if (Portal.active(name)) ctrl.activate();
});

// ── 平台内部策略总览 ─────────────────────────────────────────────────────────
const strategyOverviewKeys = ['de', 'ex', 'rs'];
let strategyOverviewTimer = null;
let strategyOverviewRequest = null;
let strategyOverviewPayload = null;
let strategyOverviewGeneration = 0;
function renderInternalStrategyOverview(payload) {
  const states = payload?.strategies || {};
  let totalEquity = 0, totalCapital = 0, totalPnl = 0, totalRealized = 0, totalUnrealized = 0, totalVolume = 0, totalRungs = 0;
  for (const key of strategyOverviewKeys) {
    const state = states[key] || {};
    const prefix = `ov-${key}`;
    const setText = (suffix, value) => { const node = $(`${prefix}-${suffix}`); if (node) node.textContent = value; };
    const setHtml = (suffix, value) => { const node = $(`${prefix}-${suffix}`); if (node) node.innerHTML = value; };
    const pnl = Number(state.totalPnl) || 0, realized = Number(state.realizedPnl) || 0, unrealized = Number(state.unrealizedPnl) || 0;
    const equity = Number(state.equity) || 0, capital = Number(state.capital) || 0, volume = Number(state.stats?.volume) || 0;
    if (state.running) {
      totalEquity += equity;
      totalCapital += capital;
    }
    totalPnl += pnl; totalRealized += realized; totalUnrealized += unrealized; totalVolume += volume; totalRungs += Number(state.stats?.completedRungs) || 0;
    const dot = $(`${prefix}-dot`); if (dot) dot.className = `run-dot${state.running ? ' on' : ''}`;
    const badge = $(`${prefix}-badge`); if (badge) { badge.textContent = 'INTERNAL'; badge.className = 'badge badge-paper'; }
    setText('health', state.running ? `🟢 运行中 · ${modeLabel(state.config?.mode)}` : '⚪ 未运行');
    setHtml('pnl', `<span class="${cls(pnl)}">${signed(pnl)}</span>`);
    setHtml('ret', `<span class="${cls(Number(state.returnPct) || 0)}">收益率 ${Number(state.returnPct) >= 0 ? '+' : ''}${state.returnPct ?? 0}%</span>`);
    setText('bal', state.capital ?? '0.0'); setText('eq', state.equity ?? '0.0');
    setHtml('rpnl', `<span class="${cls(realized)}">${signed(realized)}</span>`);
    setHtml('upnl', `<span class="${cls(unrealized)}">${signed(unrealized)}</span>`);
    setText('vol', fmt(volume)); setText('rungs', `${state.stats?.completedRungs || 0} 格`);
    setText('price', state.lastPrice ? fmtMarketPrice(state.lastPrice) : '—');
    setText('mkt', state.config?.displayName || '—');
    const configBox = $(`${prefix}-gridcfg`);
    if (configBox) {
      if (state.running && state.config) {
        configBox.style.display = '';
        configBox.innerHTML = `<div class="gc-title">本次运行参数</div>方向 <b>${modeLabel(state.config.mode)}</b> · 交易对 <b>${state.config.displayName}</b><br>区间 <b>${state.config.lower}</b> - <b>${state.config.upper}</b> · <b>${state.config.gridCount}</b> 格<br>投入 <b>${state.capital}</b> USDT · 杠杆 <b>${state.config.leverage}x</b>`;
      } else { configBox.style.display = 'none'; configBox.replaceChildren(); }
    }
    const trend = $(`${prefix}-trend`); if (trend) { trend.className = `trend-box ${state.running ? 'trend-ok' : 'trend-idle'}`; trend.textContent = state.running ? '平台内部行情运行正常' : '策略未运行'; }
  }
  const running = Number(payload?.runningCount) || 0;
  if ($('tot-equity')) $('tot-equity').textContent = fmt(totalEquity);
  if ($('tot-balance')) $('tot-balance').textContent = fmt(totalCapital);
  if ($('tot-pnl')) $('tot-pnl').innerHTML = `<span class="${cls(totalPnl)}">${signed(totalPnl)}</span>`;
  if ($('tot-realized')) $('tot-realized').innerHTML = `<span class="${cls(totalRealized)}">${signed(totalRealized)}</span>`;
  if ($('tot-unrealized')) $('tot-unrealized').innerHTML = `<span class="${cls(totalUnrealized)}">${signed(totalUnrealized)}</span>`;
  if ($('tot-volume')) $('tot-volume').textContent = fmt(totalVolume);
  if ($('tot-rungs')) $('tot-rungs').textContent = totalRungs;
  if ($('tot-running')) $('tot-running').innerHTML = running ? `<span class="up">${running}/3 运行中</span>` : '<span class="muted">全部停止</span>';
  if ($('tot-modes')) $('tot-modes').textContent = strategyOverviewKeys.map(key => modeLabel(states[key]?.config?.mode)).join(' / ');
}
async function refreshInternalStrategyOverview() {
  if (!Portal.active('overview')) return;
  if (strategyOverviewRequest) return strategyOverviewRequest;
  const generation = strategyOverviewGeneration, wallet = Portal.walletKey();
  const valid = () => generation === strategyOverviewGeneration && wallet === Portal.walletKey();
  strategyOverviewRequest = (async () => {
    try {
      if (!window.currentWalletProfile?.authenticated) {
        if (!window.currentWalletConnection?.address) {
          renderInternalStrategyUnavailable('请先连接钱包');
          return;
        }
        const profile = await loadWalletProfile?.();
        if (!profile?.authenticated) {
          renderInternalStrategyUnavailable('请先验证钱包');
          return;
        }
      }
      const response = await fetch('/api/internal-strategy/summary', { signal:AbortSignal.timeout(5000) });
      if (response.status === 401) {
        renderInternalStrategyUnavailable('请先验证钱包');
        return;
      }
      if (!response.ok) throw new Error(`请求失败（${response.status}）`);
      const next = await response.json();
      if (!valid()) return;
      strategyOverviewPayload = next;
      renderInternalStrategyOverview(strategyOverviewPayload);
    } catch (error) {
      if (valid() && !strategyOverviewPayload) renderInternalStrategyUnavailable('策略数据暂时不可用');
      console.warn('[internal-strategy] overview refresh failed:', error.message);
    } finally {
      if (valid()) strategyOverviewRequest = null;
    }
  })();
  return strategyOverviewRequest;
}
function renderInternalStrategyUnavailable(message) {
  ['de', 'ex', 'rs'].forEach(key => {
    const health = $(`ov-${key}-health`);
    if (health) health.textContent = message;
  });
  ['tot-equity', 'tot-balance', 'tot-pnl', 'tot-realized', 'tot-unrealized', 'tot-volume', 'tot-rungs', 'tot-running', 'tot-modes']
    .forEach(id => { if ($(id)) $(id).textContent = '—'; });
}
window.InternalStrategyOverview = {
  activate() {
    refreshInternalStrategyOverview();
    if (!strategyOverviewTimer) strategyOverviewTimer = setInterval(() => {
      if (!document.hidden && $('tab-overview')?.classList.contains('active')) refreshInternalStrategyOverview();
    }, 3000);
  },
};
