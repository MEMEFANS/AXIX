// ── 总览 SSE + 程序运行状态（后端连接心跳）─────────────────────────────────────
// 服务器每秒推送一次总览数据。只要心跳正常即视为"正常运行"；心跳停止
// （服务器崩溃、网络断开、电脑休眠）则显示"连接不稳/已掉线"。
let lastBeat = 0;
let lastOverview = {};
const ovEs = new EventSource('/api/overview/stream');
ovEs.onmessage = (e) => {
  lastBeat = Date.now();
  try { renderOverview(JSON.parse(e.data)); } catch {}
};
ovEs.onerror = () => updateConnStatus(); // 浏览器会自动重连，这里只刷新显示

function updateConnStatus() {
  const el = $('hdr-conn'), txt = $('hdr-conn-txt');
  if (!el || !txt) return;
  const age = Date.now() - lastBeat;
  let cls, label;
  if (lastBeat === 0) {
    cls = 'warn'; label = '连接中…';
  } else if (age < 3000) {
    cls = 'online'; label = '正常运行';
  } else if (age < 10000) {
    cls = 'warn'; label = '连接不稳…';
  } else {
    cls = 'offline'; label = '已掉线';
  }
  el.className = 'conn ' + cls;
  txt.textContent = label;
  el.title = '后端连接状态' + (lastBeat ? `（最后更新 ${Math.round(age / 1000)} 秒前）` : '');
  if (lastBeat && age >= 10000) ['de','ex','rs'].forEach((p) => setExHealth(p, lastOverview[p]?.health, false));
}
setInterval(updateConnStatus, 1000);
updateConnStatus();

// ── 趋势预警 ──────────────────────────────────────────────────────────────────
// 定时扫描各交易所"运行中"网格所在币种的趋势，与网格类型(中性/做多/做空)比对：
// 趋势变化（可能突破/反转）时在对应卡片上高亮提示。使用与"市场与趋势"相同的分析。
const MODE_LABEL = { neutral: '中性', long: '做多', short: '做空' };
const TREND_LABEL = { up: '上升', down: '下降', range: '震荡' };

async function scanTrends() {
  for (const p of ['de', 'ex', 'rs']) {
    const box = $(`ov-${p}-trend`);
    if (!box) continue;
    const d = lastOverview[p];
    if (!d || !d.running || !d.config || d.config.marketId == null) {
      box.className = 'trend-box trend-idle';
      box.textContent = '趋势监测：未运行';
      continue;
    }
    try {
      const r = await fetch(`/api/${p}/trend?marketId=${d.config.marketId}&intervalSec=3600`);
      const j = await r.json();
      if (!j.analysis) throw new Error('no analysis');
      renderTrendWarn(box, d.config.mode, j.analysis, d.config.displayName);
    } catch {
      box.className = 'trend-box trend-idle';
      box.textContent = '趋势监测：数据暂不可用';
    }
  }
}

function renderTrendWarn(box, mode, a, name) {
  const rec = a.recommended;                       // long | short | neutral
  const tl = TREND_LABEL[a.trend] || a.trend;
  const pct = Math.round((a.strength || 0) * 100);
  const sym = String(name || '').split(/[-/]/)[0] || '该币';
  if (rec === mode) {
    box.className = 'trend-box trend-ok';
    box.textContent = `✓ 趋势一致：${tl}（${MODE_LABEL[mode] || mode}网格 · 强度${pct}%）`;
    return;
  }
  const reversed = (mode === 'long' && rec === 'short') || (mode === 'short' && rec === 'long');
  if (reversed) {
    box.className = 'trend-box trend-alert';
    box.innerHTML = `🔴 ${sym} 趋势反转为<b>${tl}</b>（强度${pct}%），当前为${MODE_LABEL[mode]}网格，风险较高，建议尽快复核`;
  } else if (mode === 'neutral') {
    box.className = 'trend-box trend-watch';
    box.innerHTML = `⚠️ ${sym} 出现<b>${tl}</b>趋势（强度${pct}%），中性网格或将单边突破区间`;
  } else {
    box.className = 'trend-box trend-watch';
    box.innerHTML = `⚠️ ${sym} 趋势转为<b>${tl}</b>（强度${pct}%），与${MODE_LABEL[mode]}网格不一致`;
  }
}
scanTrends();
setInterval(scanTrends, 60000); // 每分钟扫描一次趋势

// 重新与交易所建立连接（不撤单、不平仓、不改网格状态；成功后自动对账一次）
async function reconnectEx(p, btn) {
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 重连中…'; }
  try {
    const r = await fetch(`/api/${p}/reconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = await r.json();
    if (j.error) {
      alert(`${p.toUpperCase()} 重连失败：${j.error}\n\n请检查网络/代理后再试。`);
    } else {
      if (j.resumeError) alert(`${p.toUpperCase()} 已重连，但自动续跑失败：${j.resumeError}\n挂单保留未动，可稍后重启程序再试。`);
      if (btn) {
        btn.textContent = j.resumed ? '✅ 已重连并续跑网格' : '✅ 已重连';
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
        return;
      }
    }
  } catch (e) {
    alert(`${p.toUpperCase()} 重连失败：${e.message}`);
  }
  if (btn) { btn.textContent = orig; btn.disabled = false; }
}

function setExHealth(p, h, connected) {
  const status = !connected ? 'error' : (h?.status || 'idle');
  const reason = !connected ? '后端连接中断，状态未知' : (h?.reason || '未运行');
  const dot = $(`hdr-${p}-dot`);
  if (dot) { dot.className = 'hdot ' + status; dot.title = `${p.toUpperCase()}：${reason}`; }
  const line = $(`ov-${p}-health`);
  if (line) {
    const icon = status === 'ok' ? '🟢' : status === 'warn' ? '🟡' : status === 'error' ? '🔴' : '⚪';
    line.className = 'exhealth eh-' + status;
    line.textContent = `${icon} ${reason}`;
  }
}

function renderOverview(data) {
  lastOverview = data;
  // 三所汇总
  let totEquity = 0, totBalance = 0, totPnl = 0, totRealized = 0, totUnrealized = 0, totVolume = 0, totRungs = 0;
  let running = 0;

  ['de','ex','rs'].forEach(p => {
    const d = data[p];
    if (!d) return;
    if (d.balance != null) totBalance += d.balance;
    if (d.equity != null) totEquity += d.equity;
    if (d.totalPnl != null) totPnl += d.totalPnl;
    if (d.realizedPnl != null) totRealized += d.realizedPnl;
    if (d.unrealizedPnl != null) totUnrealized += d.unrealizedPnl;
    if (d.volume != null) totVolume += d.volume;
    totRungs += d.completedRungs || 0;
    if (d.running) running++;

    // Per-exchange overview
    const dot = $(`ov-${p}-dot`);
    dot.className = 'run-dot' + (d.running ? ' on' : '');
    const badge = $(`ov-${p}-badge`);
    badge.textContent = d.mode?.toUpperCase() || 'PAPER';
    badge.className = 'badge ' + (d.mode === 'live' ? 'badge-live' : 'badge-paper');
    setExHealth(p, d.health, true);

    $(`ov-${p}-pnl`).innerHTML = `<span class="${cls(d.totalPnl)}">${signed(d.totalPnl)}</span>`;
    $(`ov-${p}-ret`).innerHTML = d.returnPct != null ? `<span class="${cls(d.returnPct)}">收益率 ${d.returnPct >= 0 ? '+' : ''}${d.returnPct}%</span>` : '收益率 —';
    $(`ov-${p}-bal`).textContent = fmt(d.balance);
    $(`ov-${p}-eq`).textContent = fmt(d.equity);
    $(`ov-${p}-rpnl`).innerHTML = `<span class="${cls(d.realizedPnl)}">${signed(d.realizedPnl)}</span>`;
    $(`ov-${p}-upnl`).innerHTML = `<span class="${cls(d.unrealizedPnl)}">${signed(d.unrealizedPnl)}</span>`;
    $(`ov-${p}-vol`).textContent = fmt(d.volume);
    $(`ov-${p}-rungs`).textContent = `${d.completedRungs || 0} 格`;
    $(`ov-${p}-price`).textContent = d.lastPrice ?? '—';
    $(`ov-${p}-mkt`).textContent = d.config?.displayName ?? '—';

    // 本次启动参数：启动网格后显示（下/上边界、格数、每格数量、杠杆、区间外策略），
    // 停止后自动清空；重新启动即显示新一轮参数。调整区间后同步更新。
    const gc = $(`ov-${p}-gridcfg`);
    if (gc) {
      const c = d.config;
      if (d.running && c && c.mode === 'recovery') {
        gc.style.display = '';
        gc.innerHTML = `<div class="gc-title">本次启动参数</div>`
          + `回收阶梯模式（只减仓）· 阶梯间距 <b>${c.spacing ?? '—'}</b> · 每档 <b>${c.sizeBase ?? '—'}</b>`;
      } else if (d.running && c && c.lower != null) {
        const sl = c.outOfRangeAction === 'recover' ? '只减仓回收阶梯' : '冲破区间平仓';
        const modeTxt = c.mode === 'long' ? '做多' : c.mode === 'short' ? '做空' : '中性';
        gc.style.display = '';
        gc.innerHTML = `<div class="gc-title">本次启动参数（${modeTxt}网格）</div>`
          + `下边界 <b>${c.lower}</b> · 上边界 <b>${c.upper}</b><br>`
          + `网格 <b>${c.gridCount}</b> 格 · 每格 <b>${c.sizeBase}</b><br>`
          + `杠杆 <b>${c.leverage}x</b> · 区间外策略 <b>${sl}</b>`;
      } else {
        gc.style.display = 'none';
        gc.innerHTML = '';
      }
    }
  });

  renderDailyReport(data, { totEquity, totBalance, totPnl });

  // Totals
  $('tot-equity').innerHTML = `<span class="${totEquity > 0 ? '' : 'muted'}">${fmt(totEquity)}</span>`;
  $('tot-balance').textContent = fmt(totBalance);
  $('tot-pnl').innerHTML = `<span class="${cls(totPnl)}">${signed(totPnl)}</span>`;
  $('tot-realized').innerHTML = `<span class="${cls(totRealized)}">${signed(totRealized)}</span>`;
  $('tot-unrealized').innerHTML = `<span class="${cls(totUnrealized)}">${signed(totUnrealized)}</span>`;
  $('tot-volume').textContent = fmt(totVolume);
  $('tot-rungs').textContent = totRungs;
  $('tot-running').innerHTML = running === 0
    ? '<span class="muted">全部停止</span>'
    : `<span class="up">${running}/3 运行中</span>`;
  const modes = ['de','ex','rs'].map(p => data[p]?.mode?.toUpperCase() || 'PAPER').join(' / ');
  $('tot-modes').textContent = `DE / EX / RS : ${modes}`;
}

function renderDailyReport(data, totals) {
  const names = { de:'Decibel', ex:'Extended', rs:'RISEx' };
  const rows = [];
  let initial = 0, todayPnl = 0, todayRungs = 0, wins = 0, losses = 0;
  for (const p of ['de','ex','rs']) {
    const d = data[p] || {}, daily = d.dailyStats || {};
    const settled = (daily.wins || 0) + (daily.losses || 0);
    const winRate = settled ? `${round((daily.wins || 0) / settled * 100)}%（${settled}笔样本）` : '—';
    const pnl = Number(daily.realizedPnl) || 0;
    rows.push(`<tr><td>${names[p]}</td><td>${daily.completedRungs || 0} 格</td><td>${winRate}</td><td>${tradeMoneyHtml(pnl)}</td></tr>`);
    const inferredInitial = Number(d.equity) - (Number(d.totalPnl) || 0);
    initial += Number(d.startBalance) || (Number.isFinite(inferredInitial) && inferredInitial > 0 ? inferredInitial : 0);
    todayPnl += pnl; todayRungs += Number(daily.completedRungs) || 0;
    wins += Number(daily.wins) || 0; losses += Number(daily.losses) || 0;
  }
  const totalSettled = wins + losses;
  const totalWinRate = totalSettled ? round(wins / totalSettled * 100) : null;
  const totalReturn = initial > 0 ? round((Number(totals.totPnl) || 0) / initial * 100) : null;
  $('ov-daily-date').textContent = new Date().toLocaleDateString('zh-CN');
  $('ov-daily-body').innerHTML = rows.join('');
  $('ov-daily-summary').innerHTML = `账本累计完成 <b>${todayRungs} 格</b> · 留存样本胜率 <b>${totalWinRate == null ? '—' : totalWinRate + '%'}</b> · 累计已实现 ${tradeMoneyHtml(todayPnl)}<br>`
    + `当前总资金 <b>${fmt(totals.totEquity)}</b> · 资金变化 ${tradeMoneyHtml(totals.totPnl)} · 汇总收益率 <b class="${cls(totalReturn)}">${totalReturn == null ? '—' : (totalReturn >= 0 ? '+' : '') + totalReturn + '%'}</b>`;
}

function modeLabel(m) { return m==='long'?'做多网格':m==='short'?'做空网格':'中性网格'; }
