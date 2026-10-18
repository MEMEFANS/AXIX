/* Mobile trading reuses the canonical controls, chart and account state. */
(() => {
  const root = document.getElementById('tab-trade');
  if (!root) return;
  const $ = id => document.getElementById(id);
  const find = selector => root.querySelector(selector);
  const media = matchMedia('(max-width: 768px)');
  const icons = {
    market:'<path d="M4 19V12M10 19V8M16 19V4" stroke-width="4"/>',
    trade:'<circle cx="8" cy="15" r="5"/><circle cx="16" cy="7" r="5"/><path d="m7 8 7 8"/>',
    account:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="9" r="3"/><path d="M6 19v-2a6 5 0 0 1 12 0v2"/>',
    globe:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 9h18M3 15h18"/>',
    settings:'<path d="m9 3 1-2h4l1 2 2 1 2-.2 2 3-1.2 2V13l1.2 2-2 3-2-.2-2 1-1 2h-4l-1-2-2-1-2 .2-2-3L4.2 13V9L3 7l2-3 2 .2Z"/><circle cx="12" cy="11" r="3"/>',
    expand:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
    cursor:'<path d="M12 2v7m0 6v7M2 12h7m6 0h7"/>',
    trend:'<path d="m5 19 14-14"/><circle cx="4" cy="20" r="2"/><circle cx="20" cy="4" r="2"/>',
    horizontal:'<path d="M3 12h18"/><circle cx="6" cy="12" r="2"/>',
    fib:'<path d="M3 4h18M3 10h18M3 14h18M3 20h18"/><circle cx="6" cy="4" r="2"/><circle cx="18" cy="20" r="2"/>',
    measure:'<path d="m3 17 14-14 4 4L7 21Zm3-3 3 3m0-6 2 2m1-5 3 3"/>',
    undo:'<path d="m8 5-5 5 5 5M3 10h11a6 6 0 0 1 0 12"/>',
    trash:'<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
    candle:'<path d="M7 2v4m0 11v5M17 2v8m0 8v4M4 6h6v11H4Zm10 4h6v8h-6Z"/>',
    chevron:'<path d="m6 9 6 6 6-6"/>',
    close:'<path d="m6 6 12 12M6 18 18 6"/>',
  };
  const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ''}</svg>`;
  const make = (tag, cls, html) => { const el = document.createElement(tag); el.className = cls; el.innerHTML = html; return el; };
  const iconButton = (action, label, icon) => `<button type="button" data-mt-action="${action}" aria-label="${label}" title="${label}">${svg(icon)}</button>`;
  const terminal = find('.trade-terminal');
  const chartPanel = find('.terminal-chart');
  const entry = find('.order-entry');
  const book = find('.orderbook-panel');
  const moves = [];
  let mounted = false, view = 'market', marketView = 'chart', lastPair = '', lastProduct = '';
  let chartReady = false, savedChartOptions, savedCandleOptions, initialVolume, savedPaneFactors, mobileVolume = true;
  const copyOptions = value => Array.isArray(value) ? value.map(copyOptions) : value && typeof value==='object' ? Object.fromEntries(Object.entries(value).map(([key,item])=>[key,copyOptions(item)])) : value;
  let savedLangMarkup, chartPoll, drawTool = 'cursor', drawStart = null;
  let fullChart = false, priceScaleMode = 0, candleMode = false, syncingAccount = false;
  const drawings = [];

  const marketTabs = make('div', 'mt-only mt-market-tabs', ['chart','book','trades','funding'].map((v,i) => `<button type="button" data-mt-market="${v}">${['图表','订单簿','最新成交','资金费'][i]}</button>`).join(''));
  marketTabs.setAttribute('role', 'tablist');
  marketTabs.setAttribute('aria-label', '行情视图');
  find('.terminal-marketbar').after(marketTabs);
  const detailButton = make('button', 'mt-only mt-market-details', svg('chevron'));
  detailButton.type = 'button'; detailButton.setAttribute('aria-label', '查看行情详情');
  detailButton.addEventListener('click', () => openSheet('details'));
  find('.terminal-marketbar').append(detailButton);
  const subtitle = make('span', 'mt-only mt-product-leverage', '');
  $('trade-product-label').after(subtitle);
  const tfOptions = [
    { value: '60', label: '1分' }, { value: '300', label: '5分' },
    { value: '900', label: '15分' }, { value: '3600', label: '1小时' },
    { value: '14400', label: '4小时' }, { value: '86400', label: '1天' },
  ];
  const tfMenuHtml = `<div class="mt-tf-menu" role="menu">${tfOptions.map(o=>`<button type="button" role="menuitem" data-mt-tf="${o.value}">${o.label}</button>`).join('')}</div>`;
  const toolbar = make('div', 'mt-only mt-chart-toolbar', `
    <button type="button" data-mt-sec="300">5分</button><button type="button" data-mt-sec="3600">1小时</button><button type="button" data-mt-sec="86400">天</button>
    <div class="mt-tf-wrap"><button type="button" id="mt-timeframe" aria-label="图表周期" aria-haspopup="true">
      <span class="mt-tf-label">1小时</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="#a3b2b8" stroke-width="1.5"><path d="m6 9 6 6 6-6"/></svg>
    </button>${tfMenuHtml}</div>
    ${iconButton('candles', '切换空心 K 线', 'candle')}${iconButton('fullscreen', '全屏图表', 'expand')}`);
  chartPanel.prepend(toolbar);
  const chartArea = make('div', 'mt-only mt-chart-area', '');
  const drawingToolbar = make('div', 'mt-drawing-tools', ['cursor','trend','horizontal','fib','measure','undo','trash'].map((v,i) => iconButton(v, ['十字光标','绘制趋势线：选择两个点','绘制水平线：选择价格','斐波那契：选择两个点','测量涨跌：选择两个点','撤销上一条绘图','清除绘图'][i], v)).join(''));
  const chartMain = make('div', 'mt-chart-main', '<div class="mt-chart-legend"><span id="mt-chart-symbol"></span><b id="mt-chart-price"></b></div><div class="mt-draw-status" id="mt-draw-status" role="status" hidden></div>');
  chartArea.append(drawingToolbar, chartMain);
  toolbar.after(chartArea);
  const footer = make('div', 'mt-only mt-chart-footer', '<button type="button" data-mt-action="fit">日期范围</button><time id="mt-clock"></time><button type="button" data-mt-action="percent" aria-pressed="false">%</button><button type="button" data-mt-action="log" aria-pressed="false">log</button><button type="button" data-mt-action="auto" class="active">自动</button>');
  chartArea.after(footer);
  const controls = make('div', 'mt-only mt-order-controls', '<select id="mt-order-type" aria-label="订单类型"><option value="market">市价</option><option value="limit">限价</option><option value="trigger">条件单</option></select><span class="mt-spot-tag">现货</span>');
  entry.prepend(controls);
  const sliderWrap = make('div', 'mt-only mt-slider', '<label><input id="mt-percent" type="number" min="0" max="100" value="0" inputmode="numeric" aria-label="下单余额百分比"><span>%</span></label>');
  entry.append(sliderWrap);
  const bookFooter = make('div', 'mt-only mt-book-footer', '<div class="mt-book-display" aria-label="盘口显示">'+['all','ask','bid'].map((v,i) => `<button type="button" data-mt-book="${v}" aria-label="${['买卖盘','仅卖盘','仅买盘'][i]}" aria-pressed="${i===0}"><i></i><i></i></button>`).join('')+'</div>');
  book.append(bookFooter);
  const bookHint = make('div', 'mt-only mt-book-hint', '点击盘口价格可填入限价单');
  book.append(bookHint);
  const funding = make('section', 'mt-only mt-funding', '<h2>资金费</h2><p>永续合约每 8 小时结算</p><div><span>当前资金费率</span><strong id="mt-funding-rate">—</strong></div><div><span>距下次结算</span><strong id="mt-funding-countdown">—</strong></div><p id="mt-funding-note">暂无资金费数据</p>');
  find('.terminal-grid').append(funding);
  const nav = make('nav', 'mt-only mt-bottom-nav', ['market','trade','account'].map((v,i) => `<button type="button" data-mt-view="${v}" aria-label="${['市场','交易','账户'][i]}">${svg(v)}<span>${['市场','交易','账户'][i]}</span></button>`).join(''));
  nav.setAttribute('aria-label', '交易底部导航'); root.append(nav);
  const sheet = make('dialog', 'mt-sheet', '<div class="mt-sheet-head"><h2 id="mt-sheet-title"></h2><button type="button" aria-label="关闭面板">'+svg('close')+'</button></div><div id="mt-sheet-body"></div>');
  sheet.setAttribute('aria-labelledby','mt-sheet-title'); document.body.append(sheet);
  sheet.querySelector('button').addEventListener('click', () => sheet.close());
  sheet.addEventListener('click', e => { if (e.target === sheet) { const r=sheet.getBoundingClientRect(); if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom) sheet.close(); } });
  sheet.addEventListener('close', () => { if (mounted) chartPanel.append($('trade-indicators')); });

  function relocate(node, target, before = null) {
    const anchor = document.createComment('mobile-trade original position');
    node.before(anchor); moves.push({node,anchor}); target.insertBefore(node,before);
  }
  function mount() {
    if (mounted) return;
    mounted = true;
    // 移动端交易页只保留右侧菜单入口：移除独立设置齿轮，
    // 将原有三横线菜单放回顶部右侧，避免左侧占用品牌区域。
    relocate($('mobile-nav-toggle'),document.querySelector('.header-right'));
    relocate($('trade-chart'),chartMain);
    relocate($('trade-indicators'),chartPanel);
    relocate($('trade-margin-mode-field'),controls);
    relocate($('trade-leverage-field'),controls);
    relocate(find('.amount-slider'),sliderWrap,sliderWrap.firstChild);
    relocate($('trade-book-precision'),bookFooter,bookFooter.firstChild);
    savedLangMarkup = $('lang-toggle').innerHTML; $('lang-toggle').innerHTML = svg('globe');
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>{if(mounted)$('lang-toggle').innerHTML=svg('globe');},{once:true});
    $('trade-order-size').setAttribute('aria-label','下单数量或金额');
    $('trade-order-size').setAttribute('inputmode','decimal');
    $('trade-order-size').setAttribute('min','0'); $('trade-order-size').setAttribute('step','any');
    $('trade-order-price').setAttribute('aria-label','委托价格');
    $('trade-trigger-price').setAttribute('aria-label','触发价格');
    $('trade-reduce-only-toggle').setAttribute('aria-label','只减仓');
    find('#trade-opening-margin-row > span').textContent='预计保证金';
    sync(); syncActive(); setView(view, false);
    initChart();
    if (!chartReady) chartPoll = setInterval(initChart, 250);
  }
  function unmount() {
    if (!mounted) return;
    sheet.close(); setFullscreen(false); clearInterval(chartPoll);
    clearDrawings();
    mounted = false;
    for (const {node,anchor} of moves.reverse()) { anchor.replaceWith(node); }
    moves.length = 0;
    $('lang-toggle').innerHTML = savedLangMarkup;
    document.body.classList.remove('mt-trading');
    $('trade-buy-label').textContent=window.tradeProduct==='perp'?'做多':'买入';
    $('trade-sell-label').textContent=window.tradeProduct==='perp'?'做空':'卖出';
    find('#trade-opening-margin-row > span').textContent='预计开仓保证金';
    $('trade-book-panel').querySelector('.book-head span:nth-child(2)').textContent='数量';
    if (chartReady) {
      tradeChart.unsubscribeClick(onChartClick);
      tradeChart.applyOptions(savedChartOptions);
      tradeCandleSeries.applyOptions(savedCandleOptions);
      setTradeVol(initialVolume);
      savedPaneFactors?.forEach((factor,i)=>tradeChart.panes()[i]?.setStretchFactor(factor));
      chartReady = false;
    }
    window.TradeBookTabs?.setActive('book'); setTradeChartView('chart');
  }
  function syncActive() {
    const active = mounted && root.classList.contains('active');
    document.body.classList.toggle('mt-trading', active);
    if (!active) { sheet.close(); setFullscreen(false); }
  }
  function setView(next, scroll = true) {
    if (!['market','trade','account'].includes(next)) return;
    view = next; root.dataset.mobileView = next;
    nav.querySelectorAll('button').forEach(b => { b.classList.toggle('active',b.dataset.mtView===view); b.setAttribute('aria-current',b.dataset.mtView===view?'page':'false'); });
    if (view === 'trade') window.TradeBookTabs?.setActive('book');
    if (view === 'market') setMarketView(marketView);
    if (view === 'account') renderTradeAccount();
    setFullscreen(false);
    if (scroll) window.scrollTo({top:0,behavior:'instant'});
  }
  function setMarketView(next) {
    marketView = next === 'funding' && window.tradeProduct !== 'perp' ? 'details' : next;
    root.dataset.mobileMarket = marketView;
    marketTabs.querySelectorAll('button').forEach(b => { const active = b.dataset.mtMarket===marketView || (b.dataset.mtMarket==='funding'&&marketView==='details'); b.classList.toggle('active',active); b.setAttribute('role','tab'); b.setAttribute('aria-selected',String(active)); });
    if (marketView==='chart') setTradeChartView('chart');
    if (marketView==='details') setTradeChartView('details');
    window.TradeBookTabs?.setActive(marketView==='trades'?'trades':'book');
  }
  function sync() {
    if (!mounted) return;
    const perp = window.tradeProduct==='perp';
    const product = perp?'perp':'spot';
    $('trade-buy-label').textContent=perp?'买入 / 做多':'买入';
    $('trade-sell-label').textContent=perp?'卖出 / 做空':'卖出';
    if(lastProduct!==product) {
      if(lastProduct) { $('trade-order-size').value=''; resetPercent(); updateTradeOrderPanel(); }
      lastProduct=product;
      syncingAccount=true;
      find(`#trade-account-tabs [data-view="${perp?'positions':'balances'}"]`)?.click();
      syncingAccount=false;
    }
    root.dataset.mobileProduct = perp?'perp':'spot';
    root.dataset.mobileOrder = find('#trade-order-types button.active')?.dataset.orderType || 'market';
    $('mt-order-type').value = root.dataset.mobileOrder;
    subtitle.textContent = perp ? $('trade-leverage-trigger').textContent : '现货';
    const pair = $('trade-symbol').textContent;
    if (lastPair && lastPair!==pair+perp) { clearDrawings(); drawStart=null; }
    lastPair = pair+perp;
    $('mt-chart-symbol').textContent = pair.replace(/\s/g,'')+' · '+find('.mt-tf-wrap .mt-tf-label')?.textContent;
    $('mt-chart-price').textContent = $('trade-mark-price').textContent;
    const fundingTab = marketTabs.querySelector('[data-mt-market="funding"]');
    const fundingText = perp?'资金费':'详情';
    if(fundingTab.textContent!==fundingText) fundingTab.textContent=fundingText;
    if(!perp && marketView==='funding') setMarketView('details');
    if(perp && marketView==='details') setMarketView('chart');
    const base = $('trade-symbol-logo').alt || pair.split('/')[0].trim();
    const bookLabel = $('trade-book-panel').querySelector('.book-head span:nth-child(2)');
    const label = `数量 (${base})`;
    if(bookLabel.textContent!==label) bookLabel.textContent=label;
  }
  function timeframe(sec) { find(`#trade-timeframes [data-sec="${sec}"]`)?.click(); syncTimeframe(); }
  function syncTimeframe() {
    const sec = find('#trade-timeframes .active')?.dataset.sec || '3600';
    // 同步自定义 dropdown 的当前选中
    const wrap = find('.mt-tf-wrap');
    if (wrap) {
      const cur = tfOptions.find(o => o.value === sec);
      wrap.dataset.value = sec;
      wrap.querySelector('.mt-tf-label').textContent = cur ? cur.label : sec;
      wrap.querySelectorAll('[data-mt-tf]').forEach(b => b.classList.toggle('active', b.dataset.mtTf === sec));
    }
    toolbar.querySelectorAll('[data-mt-sec]').forEach(b=>b.classList.toggle('active',b.dataset.mtSec===sec));
    sync();
  }
  function openSheet(kind) {
    const body=$('mt-sheet-body');
    if(body.contains($('trade-indicators'))) chartPanel.append($('trade-indicators'));
    body.replaceChildren();
    const titles={help:'开始使用 AxiX',details:'行情详情',settings:'交易显示设置',indicators:'图表指标'};
    $('mt-sheet-title').textContent=titles[kind];
    if(kind==='indicators') body.append($('trade-indicators'));
    if(kind==='help') {
      body.innerHTML='<ol class="mt-help"><li><b>选择交易市场</b><p>点击交易对可切换币种、现货与永续合约。</p></li><li><b>查看行情或下单</b><p>底部「市场」查看图表，「交易」设置订单类型、方向和数量。</p></li><li><b>管理账户与订单</b><p>连接钱包后，在「账户」查看资产、持仓和委托记录。</p></li></ol><button class="mt-sheet-primary" type="button">开始交易</button>';
      body.querySelector('button').onclick=()=>{sheet.close();setView('trade');};
    }
    if(kind==='details') {
      body.innerHTML='<dl class="mt-details">'+[['交易对','trade-symbol'],['最新价格','trade-mark-price'],['24h 涨跌','trade-change'],['24h 最高','trade-high'],['24h 最低','trade-low'],['24h 成交额','trade-volume']].map(([label,id])=>`<div><dt>${label}</dt><dd>${escapeHtml($(id).textContent)}</dd></div>`).join('')+'</dl>';
    }
    if(kind==='settings') {
      body.innerHTML='<label class="mt-setting-row">价格显示<select id="mt-price-mode"><option value="last">最新价格</option><option value="mark">标记价格</option></select></label><label class="mt-setting-row">显示成交量<input id="mt-volume-setting" type="checkbox"></label><label class="mt-setting-row">显示图表网格<input id="mt-grid-setting" type="checkbox"></label>';
      $('mt-price-mode').value=$('trade-price-mode').value;
      $('mt-price-mode').onchange=e=>{$('trade-price-mode').value=e.target.value;$('trade-price-mode').dispatchEvent(new Event('change',{bubbles:true}));};
      $('mt-volume-setting').checked=tradeVolVisibility;
      $('mt-volume-setting').onchange=e=>{if(chartReady)setTradeVol(e.target.checked);};
      $('mt-grid-setting').checked=tradeChart?.options().grid.vertLines.visible!==false;
      $('mt-grid-setting').onchange=e=>tradeChart?.applyOptions({grid:{vertLines:{visible:e.target.checked},horzLines:{visible:e.target.checked}}});
    }
    if(!sheet.open) sheet.showModal();
  }
  function initChart() {
    if (!mounted || !tradeChart || !tradeCandleSeries || chartReady) return;
    chartReady=true; clearInterval(chartPoll);
    const options=tradeChart.options();
    // Chart options are mutable; preserve copies for restoring the desktop view.
    savedChartOptions=copyOptions({layout:options.layout,grid:options.grid,rightPriceScale:options.rightPriceScale,timeScale:options.timeScale,handleScroll:options.handleScroll,handleScale:options.handleScale});
    savedCandleOptions=copyOptions(tradeCandleSeries.options());
    initialVolume=tradeVolVisibility;
    savedPaneFactors=tradeChart.panes().map(p=>p.getStretchFactor());
    tradeChart.applyOptions({layout:{background:{type:'solid',color:'#0d191e'},textColor:'#a2afb5',fontSize:12},grid:{vertLines:{color:'#19292f'},horzLines:{color:'#19292f'}},rightPriceScale:{borderColor:'#26363d',minimumWidth:66},timeScale:{borderColor:'#26363d',barSpacing:9}});
    tradeCandleSeries.applyOptions({upColor:'#40b5a4',downColor:'#e16980',wickUpColor:'#40b5a4',wickDownColor:'#e16980'});
    setTradeVol(mobileVolume);
    sizeVolumePane();
    tradeChart.subscribeClick(onChartClick);
    setDrawTool('cursor'); syncTimeframe();
  }
  function setFullscreen(on) {
    fullChart=on; root.classList.toggle('mt-fullscreen',on);
    toolbar.querySelector('[data-mt-action="fullscreen"]').setAttribute('aria-label',on?'退出全屏图表':'全屏图表');
  }
  function sizeVolumePane() {
    if(!mounted || !tradeChart) return;
    mobileVolume=tradeVolVisibility;
    if(!tradeVolVisibility) return;
    tradeChart.panes()[0]?.setStretchFactor(3);
    tradeChart.panes()[tradeVolPaneIdx]?.setStretchFactor(1);
  }
  function resetPercent() {
    find('.amount-slider').value='0'; $('mt-percent').value='0'; sliderWrap.style.setProperty('--percent','0%');
  }
  function setDrawTool(tool) {
    drawTool=tool; drawStart=null;
    drawingToolbar.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.mtAction===tool));
    $('mt-draw-status').hidden=tool==='cursor';
    $('mt-draw-status').textContent=tool==='horizontal'?'点击图表选择价格':'点击图表选择起点，再选择终点';
    if(chartReady) tradeChart.applyOptions({handleScroll:tool==='cursor',handleScale:tool==='cursor'});
  }
  function clearDrawings() { while(drawings.length) removeDrawing(drawings.pop()); if(mounted) setDrawTool('cursor'); }
  function removeDrawing(group) { for(const item of group) { if(item.priceLine) tradeCandleSeries.removePriceLine(item.priceLine); else tradeChart.removeSeries(item); } }
  function onChartClick(event) {
    if(!mounted || drawTool==='cursor' || !event.point || event.paneIndex>0) return;
    const price=tradeCandleSeries.coordinateToPrice(event.point.y);
    if(!Number.isFinite(price)) return;
    if(drawTool==='horizontal') {
      const priceLine=tradeCandleSeries.createPriceLine({price,color:'#50cdbb',lineWidth:1,lineStyle:2,axisLabelVisible:true,title:''});
      drawings.push([{priceLine}]); setDrawTool('cursor'); return;
    }
    if(!event.time) return;
    const point={time:event.time,value:price};
    if(!drawStart) { drawStart=point; $('mt-draw-status').textContent='起点已选，点击终点完成'; return; }
    if(point.time===drawStart.time) { $('mt-draw-status').textContent='请选择另一个时间点'; return; }
    const start=drawStart, tool=drawTool, points=[start,point].sort((a,b)=>a.time-b.time), group=[];
    const addLine=(data,color='#50cdbb')=>{const series=tradeChart.addSeries(LightweightCharts.LineSeries,{color,lineWidth:1,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false,autoscaleInfoProvider:()=>null});series.setData(data);group.push(series);};
    if(tool==='fib') [0,.236,.382,.5,.618,1].forEach((ratio,i)=>{const value=start.value+(point.value-start.value)*ratio;addLine(points.map(p=>({time:p.time,value})),['#9eaeb4','#b3a07b','#b3a07b','#50cdbb','#50cdbb','#9eaeb4'][i]);});
    else addLine(points);
    drawings.push(group); setDrawTool('cursor');
    if(tool==='measure') { $('mt-draw-status').hidden=false;$('mt-draw-status').textContent=`涨跌 ${((point.value/start.value-1)*100).toFixed(2)}% · ${Math.round(Math.abs(point.time-start.time)/60)} 分钟`; }
  }
  root.addEventListener('click',e=>{
    if(!mounted) return;
    // 自定义 tf dropdown：展开/收起 + 选择
    const tfBtn = e.target.closest('#mt-timeframe');
    if (tfBtn) { toolbar.classList.toggle('tf-open'); return; }
    const tfOpt = e.target.closest('[data-mt-tf]');
    if (tfOpt) { toolbar.classList.remove('tf-open'); timeframe(tfOpt.dataset.mtTf); return; }
    // 点外部收起 tf menu
    if (!e.target.closest('.mt-tf-wrap')) toolbar.classList.remove('tf-open');

    const b=e.target.closest('button'); if(!b)return;
    if(b.dataset.mtView) setView(b.dataset.mtView);
    if(b.dataset.mtMarket) setMarketView(b.dataset.mtMarket);
    if(b.dataset.mtSec) timeframe(b.dataset.mtSec);
    if(b.dataset.mtBook) { book.dataset.mobileBook=b.dataset.mtBook;bookFooter.querySelectorAll('[data-mt-book]').forEach(x=>x.setAttribute('aria-pressed',String(x===b))); }
    const action=b.dataset.mtAction;
    if(['cursor','trend','horizontal','fib','measure'].includes(action)) setDrawTool(action);
    if(action==='undo') {if(drawings.length)removeDrawing(drawings.pop());setDrawTool('cursor');}
    if(action==='trash') clearDrawings();
    if(action==='fullscreen') setFullscreen(!fullChart);
    if(!chartReady) return;
    if(action==='fit') tradeChart.timeScale().fitContent();
    if(action==='auto') {tradeChart.priceScale('right').applyOptions({autoScale:true});snapTradeChartToLatest();}
    if(action==='percent'||action==='log') {priceScaleMode=priceScaleMode===(action==='log'?1:2)?0:(action==='log'?1:2);tradeChart.priceScale('right').applyOptions({mode:priceScaleMode});footer.querySelectorAll('[aria-pressed]').forEach(x=>x.setAttribute('aria-pressed',String(priceScaleMode===(x.dataset.mtAction==='log'?1:2))));}
    if(action==='candles') {candleMode=!candleMode;tradeCandleSeries.applyOptions({upColor:candleMode?'#0d191e':'#40b5a4',borderVisible:candleMode,borderUpColor:'#40b5a4',borderDownColor:'#e16980'});b.setAttribute('aria-pressed',String(candleMode));}
  });
  $('mt-order-type').addEventListener('change',e=>{find(`#trade-order-types [data-order-type="${e.target.value}"]`).click();sync();});
  $('mt-percent').addEventListener('input',e=>{const percent=Math.max(0,Math.min(100,Number(e.target.value)||0));const slider=find('.amount-slider');slider.value=percent;e.target.value=percent;slider.dispatchEvent(new Event('input',{bubbles:true}));});
  find('.amount-slider').addEventListener('input',e=>{$('mt-percent').value=e.target.value;sliderWrap.style.setProperty('--percent',e.target.value+'%');});
  $('trade-order-size').addEventListener('input',()=>{if(mounted)resetPercent();});
  $('trade-account-tabs').addEventListener('click',e=>{if(mounted&&!syncingAccount&&view==='market'&&e.target.closest('[data-view]'))setView('account');});
  // A book tap changes only the form; the canonical handler fills its price.
  $('trade-book-panel').addEventListener('click',e=>{if(!mounted||!e.target.closest('.book-row'))return;if(view!=='trade')setView('trade');find('#trade-order-types [data-order-type="limit"]').click();sync();},true);
  $('trade-order-btn').addEventListener('click',e=>{if(mounted&&!window.currentWalletConnection?.address){e.stopImmediatePropagation();handleWalletButton($('wallet-connect-btn'));}},true);
  $('trade-alert-btn').addEventListener('click',()=>{if(sheet.open)sheet.close();});
  new MutationObserver(sizeVolumePane).observe(find('[data-indicator="vol"]'),{attributes:true,attributeFilter:['class']});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){setFullscreen(false);if(mounted)setDrawTool('cursor');}});
  new MutationObserver(syncActive).observe(root,{attributes:true,attributeFilter:['class']});
  const syncObserver=new MutationObserver(sync);
  for(const id of ['trade-product-label','trade-symbol','trade-leverage-trigger','trade-order-types']) syncObserver.observe($(id),{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  new MutationObserver(syncTimeframe).observe($('trade-timeframes'),{subtree:true,attributes:true,attributeFilter:['class']});
  new MutationObserver(()=>{if(mounted)$('mt-chart-price').textContent=$('trade-mark-price').textContent;}).observe($('trade-mark-price'),{childList:true,characterData:true,subtree:true});
  setInterval(()=>{
    if(!mounted||!root.classList.contains('active')||document.hidden)return;
    $('mt-clock').textContent=new Date().toLocaleTimeString('zh-CN',{hour12:false})+' (UTC'+(-new Date().getTimezoneOffset()/60>=0?'+':'')+(-new Date().getTimezoneOffset()/60)+')';
    const available=!$('trade-funding-stat').hidden;
    $('mt-funding-rate').textContent=available?$('trade-funding-rate').textContent:'—';
    $('mt-funding-countdown').textContent=available?$('trade-funding-countdown').textContent:'—';
    $('mt-funding-note').hidden=available;
  },1000);
  media.addEventListener('change',()=>media.matches?mount():unmount());
  if(media.matches) mount();
  window.MobileTrade={setView,sync};
})();
