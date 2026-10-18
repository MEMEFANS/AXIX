// 最近成交面板模块：1s 轮询 /api/market/trades，仅 active 时运行
window.TradeTrades = (() => {
  let active = false;
  let timer = null;
  let busy = false;
  let lastTrades = [];

  async function refresh() {
    if (busy) return;
    const symbol = window.tradeSymbol;
    const product = window.tradeProduct;
    if (!symbol || !product) return;
    busy = true;
    try {
      const res = await fetch(`/api/market/trades?product=${product}&symbol=${encodeURIComponent(symbol)}`);
      if (!res.ok) return;
      const data = await res.json();
      lastTrades = (data.trades || []).slice(0, 50);
      render();
    } catch {}
    finally { busy = false; }
  }

  function render() {
    const host = document.getElementById('trade-trades');
    if (!host) return;
    if (!lastTrades.length) { host.innerHTML = '<div class="terminal-empty">暂无成交</div>'; return; }
    const compact = v => {
      const n = Number(v) || 0;
      const abs = Math.abs(n);
      if (abs >= 10_000_000) return (n / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'M';
      if (abs >= 100_000) return (n / 1_000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'K';
      if (abs >= 1_000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
      return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
    };
    const rows = lastTrades.map(t => {
      const isSell = t.isBuyerMaker;
      const time = new Date(t.time).toLocaleTimeString('zh-CN', { hour12: false });
      return `<div class="book-row ${isSell ? 'ask' : 'bid'}"><span>${compact(t.price)}</span><span>${compact(t.qty)}</span><span>${time}</span></div>`;
    }).join('');
    host.innerHTML = rows;
  }

  function setActive(on) {
    active = on;
    if (on) {
      if (lastTrades.length) render();
      refresh();
      if (!timer) timer = setInterval(refresh, 1000);
    } else {
      if (timer) { clearInterval(timer); timer = null; }
    }
  }

  return { refresh, setActive, render };
})();
