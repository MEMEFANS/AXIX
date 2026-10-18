let tradeAccountView = 'balances';
let tradeOrderType = 'market';
let platformProfile = null;

async function loadPlatformProfile({ preservePositionControls = false } = {}) {
  if (!window.currentWalletProfile?.authenticated) {
    platformProfile = null;
    renderTradeAccount();
    updateQuickCloseButton();
    return null;
  }
  const data = await PlatformClient.profile(tradeSymbol);
  platformProfile = data;
  updateQuickCloseButton();
  window.TradeFunding?.update(data);
  // 更新 K 线开仓均价线（仅永续合约模式显示，现货页面不画合约持仓线）
  const perp = tradeProduct === 'perp' ? (data?.perps?.[tradeSymbol] || data?.perp) : null;
  if (window.updateTradeEntryPriceLine) {
    if (perp && Number(perp.size) !== 0) {
      updateTradeEntryPriceLine(Number(perp.entryPrice), Number(perp.size) > 0 ? 'buy' : 'sell');
    } else {
      updateTradeEntryPriceLine(0, '');
    }
  }
  // 更新价格提醒线
  window.TradeAlerts?.render(tradeSymbol);
  const liveMark = Number(tradeLatestMarks?.get?.(tradeMarketKey('perp', tradeSymbol))?.price)
    || Number(typeof tradeCurrentMarkPrice === 'undefined' ? 0 : tradeCurrentMarkPrice);
  if (liveMark > 0) updatePlatformPerpMark(tradeSymbol, liveMark);
  if (typeof updateTradeExecutionMarkers === 'function') updateTradeExecutionMarkers();
  const account = data.account || {};
  const accountValue = (value, suffix = ' USDT') => `${Number(value || 0).toLocaleString('en-US', { maximumFractionDigits:6 })}${suffix}`;
  if ($('trade-margin-used')) $('trade-margin-used').textContent = accountValue(account.marginUsed);
  if ($('trade-margin-usage')) $('trade-margin-usage').textContent = `${(Number(account.marginUsage || 0) * 100).toFixed(2)}%`;
  if (typeof updateTradeOrderPanel === 'function') updateTradeOrderPanel();
  if ($('strategy-usdc-balance')) $('strategy-usdc-balance').textContent = Number(data.strategy?.balance || 0).toLocaleString('en-US', { maximumFractionDigits:6 });
  window.ExchangeAssets?.renderPlatform(data);
  const positionTableVisible = tradeAccountView === 'positions'
    && Boolean($('trade-account-content')?.querySelector('[data-position-pnl]'));
  if (!(preservePositionControls && positionTableVisible)) renderTradeAccount();
  return data;
}

function updatePlatformPerpMark(symbol, markPrice) {
  const position = platformProfile?.perps?.[symbol];
  const price = Number(markPrice), size = Number(position?.size || 0), entry = Number(position?.entryPrice || 0);
  if (!(price > 0) || !size || !(entry > 0)) return;
  const previousPnl = Number(position.unrealizedPnl || 0);
  const nextPnl = Math.round(size * (price - entry) * 1_000_000) / 1_000_000;
  const delta = nextPnl - previousPnl;
  position.markPrice = String(price);
  position.unrealizedPnl = String(nextPnl);
  position.maintenanceMargin = String(Math.abs(size) * price * 0.005);
  const account = platformProfile.account || {};
  for (const field of ['positionEquity', 'collateralEquity', 'totalEquity']) {
    account[field] = String(Number(account[field] || 0) + delta);
  }
  const collateral = Number(account.collateralEquity || 0);
  account.marginUsage = collateral > 0 ? Number(account.marginUsed || 0) / collateral : 0;
  const accountValue = value => `${Number(value || 0).toLocaleString('en-US', { maximumFractionDigits:6 })} USDT`;
  if ($('trade-summary-available')) $('trade-summary-available').textContent = accountValue(account.availableMargin);
  if ($('trade-margin-usage')) $('trade-margin-usage').textContent = `${(Number(account.marginUsage || 0) * 100).toFixed(2)}%`;
  if (tradeAccountView === 'positions') {
    const markCell = document.querySelector(`[data-position-mark="${symbol}"]`);
    const maintenanceCell = document.querySelector(`[data-position-maintenance="${symbol}"]`);
    const pnlCell = document.querySelector(`[data-position-pnl="${symbol}"]`);
    if (markCell) markCell.textContent = formatTradePrice(price);
    if (maintenanceCell) maintenanceCell.textContent = `${Number(position.maintenanceMargin).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })} USDT`;
    if (pnlCell) {
      pnlCell.className = nextPnl >= 0 ? 'up' : 'down';
      pnlCell.textContent = `${nextPnl >= 0 ? '+' : ''}${Number(nextPnl).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })} USDT`;
    }
  }
}

let platformProfileRefreshBusy = false;
setInterval(() => {
  if (document.hidden || !document.getElementById('tab-trade')?.classList.contains('active')) return;
  if (!window.currentWalletProfile?.authenticated) return;
  const hasOpenPosition = Object.values(platformProfile?.perps || {}).some(position => Number(position?.size || 0) !== 0);
  if (!hasOpenPosition && tradeAccountView !== 'positions') return;
  if (platformProfileRefreshBusy) return;
  platformProfileRefreshBusy = true;
  loadPlatformProfile({ preservePositionControls:true }).catch(() => {}).finally(() => { platformProfileRefreshBusy = false; });
}, 3_000);

function renderTradeAccount() {
  const host = $('trade-account-content');
  if (!host) return;
  const formatBalance = value => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits:8 });
  const formatUsdt = value => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
  if (tradeAccountView === 'balances') {
    const usdc = platformProfile?.account?.availableMargin ?? '0';
    // 交易终端资产仅展示 USDT 交易账户（现货持币在下单面板按交易对上下文显示，AIX 等在资产页/赚币页查看）
    host.innerHTML = `<table class="terminal-data-table"><thead><tr><th>资产</th><th>可用余额</th><th>账户</th><th>美元价值</th></tr></thead><tbody><tr><td data-label="资产" class="asset-name">USDT</td><td data-label="可用余额">${formatBalance(usdc)}</td><td data-label="账户">交易</td><td data-label="美元价值">$${formatBalance(usdc)}</td></tr></tbody></table>`;
    return;
  }
  if (tradeAccountView === 'positions') {
    const positions=Object.values(platformProfile?.perps||{}).filter(pos=>Number(pos.size));
    if(!positions.length){host.innerHTML='<div class="terminal-empty">暂无永续持仓</div>';return;}
    const rows=positions.map(pos=>{const size=Number(pos.size)||0,entry=Number(pos.entryPrice)||0,mark=Number(pos.markPrice)||0,closeSize=Math.abs(size);const pnl=mark>0&&entry>0?Math.round(size*(mark-entry)*1_000_000)/1_000_000:Number(pos.unrealizedPnl||0);return `<tr><td data-label="市场">${pos.symbol}/USDT</td><td data-label="方向 / 数量" class="${size>0?'up':'down'}">${size>0?'多':'空'} ${formatBalance(closeSize)}</td><td data-label="开仓价">${formatTradePrice(entry)}</td><td data-label="标记价格" data-position-mark="${pos.symbol}">${mark>0?formatTradePrice(mark):'—'}</td><td data-label="强平价">${formatTradePrice(pos.liquidationPrice)}</td><td data-label="保证金 / 维持保证金">${formatUsdt(pos.margin)} / <span data-position-maintenance="${pos.symbol}">${formatUsdt(pos.maintenanceMargin)} USDT</span></td><td data-label="杠杆">${pos.leverage}x</td><td data-label="保证金模式">${pos.marginMode === 'cross' ? '全仓' : '逐仓'}</td><td data-label="资金费率盈亏">${formatUsdt(pos.fundingPnl)} USDT</td><td data-label="未实现盈亏" data-position-pnl="${pos.symbol}" class="${pnl>=0?'up':'down'}">${pnl>=0?'+':''}${formatUsdt(pnl)} USDT</td><td data-label="操作"><div class="position-close-control"><input id="perp-close-${pos.symbol}" type="number" min="0" max="${closeSize}" step="0.00000001" value="${closeSize}" aria-label="${pos.symbol} 平仓数量" oninput="this.parentElement.querySelectorAll('.position-close-percents button').forEach(b=>b.classList.remove('active'))"><div class="position-close-percents" role="group" aria-label="${pos.symbol} 平仓比例"><button type="button" onclick="setPerpClosePercent('${pos.symbol}',0.25,this)">25%</button><button type="button" onclick="setPerpClosePercent('${pos.symbol}',0.5,this)">50%</button><button type="button" onclick="setPerpClosePercent('${pos.symbol}',0.75,this)">75%</button><button type="button" class="active" onclick="setPerpClosePercent('${pos.symbol}',1,this)">100%</button></div><button class="table-action position-close-btn" onclick="closePerpPosition('${pos.symbol}',this)">市价平仓</button></div></td></tr>`}).join('');
    host.innerHTML=`<table class="terminal-data-table"><thead><tr><th>市场</th><th>方向 / 数量</th><th>开仓价</th><th>标记价格</th><th>强平价</th><th>保证金 / 维持保证金</th><th>杠杆</th><th>保证金模式</th><th>资金费率盈亏</th><th>未实现盈亏</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
    return;
  }
  if (tradeAccountView === 'orders') {
    const orders = platformProfile?.orders || [];
    const rows = orders.map(order => {const isTrigger=order.type==='trigger',direction=order.product==='perp'?(order.side==='buy'?'做多':'做空'):(order.side==='buy'?'买入':'卖出'),price=isTrigger?order.triggerPrice:order.limitPrice;return `<tr><td data-label="时间">${new Date(order.createdAt).toLocaleString('zh-CN',{hour12:false})}</td><td data-label="市场">${order.symbol}/USDT</td><td data-label="产品">${order.product === 'spot' ? '现货' : '永续'}</td><td data-label="类型">${isTrigger?'条件':'限价'}</td><td data-label="方向" class="${order.side === 'buy' ? 'up' : 'down'}">${direction}</td><td data-label="委托 / 触发价">${formatTradePrice(price)}</td><td data-label="数量">${formatBalance(order.size)} ${order.symbol}</td><td data-label="属性">${isTrigger?(order.triggerDirection==='below'?'向下触发':'向上触发'):(order.reduceOnly ? '只减仓' : '普通')}</td><td data-label="状态">${isTrigger?'等待触发':'等待成交'}</td><td data-label="操作"><button class="table-action" onclick="cancelPlatformOrder('${escapeHtml(order.id)}')">撤单</button></td></tr>`}).join('');
    host.innerHTML = rows ? `<table class="terminal-data-table"><thead><tr><th>时间</th><th>市场</th><th>产品</th><th>类型</th><th>方向</th><th>委托 / 触发价</th><th>数量</th><th>属性</th><th>状态</th><th><button class="table-action" onclick="cancelAllPlatformOrders(this)">全部撤单</button></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="terminal-empty">暂无未成交委托</div>';
    return;
  }
  if (tradeAccountView === 'history' || tradeAccountView === 'fills') {
    host.innerHTML = TradeHistory.render(platformProfile, {
      view:tradeAccountView, product:tradeProduct, symbol:tradeSymbol,
      formatPrice:formatTradeMarketPrice,
    });
    return;
  }
  host.innerHTML = '<div class="terminal-empty">市价模式无当前委托</div>';
}

function updateTradeOrderButton() {
  const button = $('trade-order-btn');
  if (!button) return;
  if (!window.currentWalletConnection?.address) {
    button.textContent = '连接钱包';
    updateQuickCloseButton();
    return;
  }
  const side = document.querySelector('.side-switch button.active')?.dataset.side || 'buy';
  button.textContent = tradeProduct === 'spot'
    ? `${side === 'buy' ? '买入' : '卖出'} ${tradeSymbol}`
    : `${side === 'buy' ? '做多' : '做空'} ${tradeSymbol}`;
  if (tradeProduct === 'perp' && $('trade-reduce-only')?.checked) button.textContent = '只减仓下单';
  else if (tradeOrderType === 'trigger') button.textContent = `提交${tradeProduct === 'spot' ? '现货' : '合约'}条件单`;
  updateQuickCloseButton();
}

// 下单区快捷平仓：合约模式下当前交易对有持仓时，在「做多/做空」按钮下方直接显示平仓按钮
// （持仓表在页面最底部，手机端滚动操作不便）。一键市价全平；部分平仓仍用底部持仓表的比例控件。
function updateQuickCloseButton() {
  const btn = $('trade-quick-close-btn');
  if (!btn) return;
  const pos = tradeProduct === 'perp' ? platformProfile?.perps?.[tradeSymbol] : null;
  const size = Number(pos?.size || 0);
  if (!size) { btn.hidden = true; return; }
  const mark = Number(pos.markPrice) || 0, entry = Number(pos.entryPrice) || 0;
  const pnl = mark > 0 && entry > 0
    ? Math.round(size * (mark - entry) * 1_000_000) / 1_000_000
    : Number(pos.unrealizedPnl || 0);
  const pnlText = `${pnl >= 0 ? '+' : ''}${Number(pnl).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}`;
  btn.hidden = false;
  btn.innerHTML = `市价平仓 · ${size > 0 ? '多' : '空'} ${Math.abs(size)} ${tradeSymbol}
    <span class="qc-pnl ${pnl >= 0 ? 'up' : 'down'}">${pnlText} USDT</span>`;
}

async function quickClosePerp(button) {
  await closePerpPosition(tradeSymbol, button);
}

async function handleTradeOrder(button) {
  const raw = Number($('trade-order-size').value);
  if (!(raw > 0)) return showToast(`请输入数量`, 'error');
  if (tradeOrderType === 'trigger' && !(Number($('trade-trigger-price').value) > 0)) return showToast('请输入触发价', 'error');
  button.disabled = true;
  try {
    await ensurePlatformSession(button);
    const side = document.querySelector('.side-switch button.active')?.dataset.side || 'buy';
    // 现货买入：trade-order-size 输入框单位是 USDT（用户填"准备花多少 USDT"），
    // 但下单接口 size 字段必须是基础资产数量（BTC/ETH 等），因此这里按市场价换算
    let size = raw;
    if (tradeProduct === 'spot' && side === 'buy') {
      const price = typeof tradeEstimatePrice === 'function' ? tradeEstimatePrice() : 0;
      // 向下取整到 8 位小数（资产精度），避免浮点除法产生超长小数导致后端"数量格式不正确"
      size = price > 0 ? Math.floor((raw / (price * 1.0005)) * 1e8) / 1e8 : 0;
      if (!(size > 0)) return showToast(price > 0 ? '买入金额过小，无法成交' : '市场价尚未准备好，请稍后再试', 'error');
    }
    const leverage = tradeProduct === 'perp' && typeof normalizeTradeLeverage === 'function'
      ? normalizeTradeLeverage($('trade-leverage').value)
      : 1;
    const data = await PlatformClient.placeOrder({ symbol:tradeSymbol, product:tradeProduct, side, size:String(size), leverage, marginMode:tradeProduct === 'perp' ? $('trade-margin-mode').value : 'isolated', reduceOnly:tradeProduct === 'perp' && $('trade-reduce-only').checked, type:tradeOrderType, limitPrice:tradeOrderType === 'limit' ? $('trade-order-price').value : '', triggerPrice:tradeOrderType === 'trigger' ? $('trade-trigger-price').value : '', triggerDirection:$('trade-trigger-direction').value, timeInForce: tradeOrderType === 'limit' ? ($('trade-tif')?.value === 'POST' ? 'GTC' : ($('trade-tif')?.value || 'GTC')) : 'GTC', postOnly: tradeOrderType === 'limit' && $('trade-tif')?.value === 'POST' });
    $('trade-order-size').value = '';
    document.querySelector('.amount-slider').value = '0';
    document.querySelectorAll('[data-amount-percent]').forEach(item => item.classList.toggle('active', item.dataset.amountPercent === '0'));
    if (typeof updateTradeOrderPanel === 'function') updateTradeOrderPanel();
    showToast(data.order ? (tradeOrderType === 'trigger' ? '条件委托已提交' : '限价委托已提交') : `成交成功 · ${Number(data.price).toLocaleString('en-US',{maximumFractionDigits:2})} USDT`, 'ok');
    await loadWalletProfile();
    await loadPlatformProfile();
  } catch (error) { showToast(error.message, 'error'); }
  finally { button.disabled = false; updateTradeOrderButton(); }
}

function setPerpClosePercent(symbol, ratio, btn = null) {
  const position = platformProfile?.perps?.[symbol] || {};
  const fullSize = Math.abs(Number(position.size) || 0);
  const input = $(`perp-close-${symbol}`);
  if (!input || !fullSize) return;
  const closeSize = Math.floor(fullSize * Math.min(1, Math.max(0, Number(ratio) || 0)) * 1e8) / 1e8;
  input.value = closeSize.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  if (btn) btn.parentElement?.querySelectorAll('button').forEach(item => item.classList.toggle('active', item === btn));
}

async function closePerpPosition(symbol = tradeSymbol, button = null) {
  const position=platformProfile?.perps?.[symbol]||{}; const size = Number(position.size || 0);
  if (!size) return showToast('当前没有永续持仓', 'error');
  const fullSize = Math.abs(size);
  const requestedSize = Number($(`perp-close-${symbol}`)?.value || fullSize);
  if (!(requestedSize > 0)) return showToast('请输入平仓数量', 'error');
  if (requestedSize > fullSize + 1e-8) return showToast('平仓数量不能超过当前持仓', 'error');
  if (button) button.disabled = true;
  try {
    await PlatformClient.placeOrder({ symbol, product:'perp', side:size > 0 ? 'sell' : 'buy', size:String(requestedSize), leverage:Number(position.leverage) || 1, marginMode:position.marginMode || 'isolated', reduceOnly:true, type:'market', limitPrice:'' });
    showToast(requestedSize >= fullSize ? '持仓已全部市价平仓' : `已市价平仓 ${requestedSize} ${symbol}`, 'ok');
    await loadWalletProfile();
    await loadPlatformProfile();
  } catch (error) { showToast(error.message, 'error'); }
  finally { if (button?.isConnected) button.disabled = false; }
}

async function cancelPlatformOrder(orderId) {
  try {
    await PlatformClient.cancelOrder(orderId);
    await loadWalletProfile();
    await loadPlatformProfile();
    showToast('委托已撤销', 'ok');
  } catch (error) { showToast(error.message, 'error'); }
}

async function cancelAllPlatformOrders(button = null) {
  const ids = (platformProfile?.orders || []).map(order => order.id).filter(Boolean);
  if (!ids.length) return showToast('当前没有可撤委托', 'error');
  if (button) button.disabled = true;
  try {
    await Promise.all(ids.map(orderId => PlatformClient.cancelOrder(orderId)));
    await loadWalletProfile();
    await loadPlatformProfile();
    showToast(`已撤销 ${ids.length} 笔委托`, 'ok');
  } catch (error) { showToast(error.message, 'error'); }
  finally { if (button?.isConnected) button.disabled = false; }
}

function availableTradeMargin() {
  return Number(platformProfile?.account?.availableMargin) || 0;
}

function availableTradeContext() {
  const side = document.querySelector('.side-switch button.active')?.dataset.side || 'buy';
  const reduceOnly = tradeProduct === 'perp' && Boolean($('trade-reduce-only')?.checked);
  if (tradeProduct === 'spot' && side === 'sell') {
    return { amount:Number(platformProfile?.spot?.[tradeSymbol]) || 0, asset:tradeSymbol, label:'平台可卖余额' };
  }
  if (reduceOnly) {
    const position = platformProfile?.perps?.[tradeSymbol] || platformProfile?.perp;
    return { amount:Math.abs(Number(position?.size) || 0), asset:tradeSymbol, label:'可减仓数量' };
  }
  return {
    amount:availableTradeMargin(),
    asset:'USDT',
    label:tradeProduct === 'perp' ? '平台可用保证金' : '平台可用余额',
  };
}
