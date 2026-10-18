// 价格提醒模块：localStorage 持久化 + 图表价格线 + 到价通知
window.TradeAlerts = (() => {
  const KEY = 'trade-alerts';
  let priceLines = new Map(); // symbol -> [{line, price}]

  function list() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
  }

  function save(arr) {
    try { localStorage.setItem(KEY, JSON.stringify(arr)); } catch {}
  }

  function forSymbol(symbol) {
    return list().filter(a => a.symbol === symbol);
  }

  function add(symbol, price) {
    const p = Number(price);
    if (!(p > 0)) return;
    const arr = list();
    if (arr.some(a => a.symbol === symbol && a.price === p)) return;
    arr.push({ symbol, price: p, created: Date.now() });
    save(arr);
    render(symbol);
  }

  function remove(symbol, price) {
    const arr = list().filter(a => !(a.symbol === symbol && a.price === price));
    save(arr);
    render(symbol);
  }

  function render(symbol) {
    if (!window.tradeChart || !window.tradeCandleSeries) return;
    // 清除旧的
    const old = priceLines.get(symbol) || [];
    old.forEach(item => { try { window.tradeCandleSeries.removePriceLine(item.line); } catch {} });
    // 添加新的
    const alerts = forSymbol(symbol);
    const lines = alerts.map(a => ({
      line: window.tradeCandleSeries.createPriceLine({
        price: a.price, color: '#f0c84b', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '提醒'
      }),
      price: a.price
    }));
    priceLines.set(symbol, lines);
  }

  function check(symbol, price) {
    const p = Number(price);
    if (!(p > 0)) return;
    forSymbol(symbol).forEach(a => {
      const diff = Math.abs(p - a.price) / a.price;
      if (diff < 0.0005 && !a.notified) {
        a.notified = true;
        if (window.showToast) showToast(`${symbol} 已到达提醒价格 ${a.price}`, 'ok');
        // 5秒后重置通知状态，允许再次触发
        setTimeout(() => { const arr = list(); const item = arr.find(x => x.symbol === symbol && x.price === a.price); if (item) { item.notified = false; save(arr); } }, 5000);
      }
    });
  }

  async function openDialog(symbol, currentPrice) {
    const price = await promptDialog(`设置 ${symbol} 价格提醒（当前 ${window.formatTradePrice ? formatTradePrice(currentPrice) : currentPrice}）\n输入提醒价格：`, currentPrice);
    if (price && Number(price) > 0) {
      add(symbol, Number(price));
      if (window.showToast) showToast(`已添加 ${symbol} 价格提醒：${Number(price)}`, 'ok');
    }
  }

  return { list, forSymbol, add, remove, render, check, openDialog };
})();
