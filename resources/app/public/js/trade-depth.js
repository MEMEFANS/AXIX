// 深度图模块：Canvas 2D 绘制累积深度山形图，复用订单簿数据
window.TradeDepth = (() => {
  let canvas = null;
  let ctx = null;
  let lastBook = null;
  let observer = null;
  let active = false;

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.getElementById('trade-depth-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    observer = new ResizeObserver(() => { resize(); if (lastBook) render(lastBook); });
    observer.observe(canvas.parentElement);
  }

  function resize() {
    if (!canvas || !ctx) return;
    const parent = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function fmtPrice(p) {
    if (window.formatTradePrice) return formatTradePrice(p);
    return Number(p).toFixed(2);
  }

  function fmtSize(s) {
    const n = Number(s);
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toFixed(3);
  }

  function render(book) {
    ensureCanvas();
    if (!canvas || !ctx) return;
    lastBook = book;
    if (!active) return;
    const w = canvas.parentElement.clientWidth;
    const h = canvas.parentElement.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const bids = book?.bids || [];
    const asks = book?.asks || [];
    if (!bids.length || !asks.length) return;

    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;
    const mid = (bestBid + bestAsk) / 2;

    // 用实际订单簿范围 ±一定比例
    const bidEnd = bids[bids.length - 1].price;
    const askEnd = asks[asks.length - 1].price;
    const bidRange = mid - bidEnd;
    const askRange = askEnd - mid;
    const maxRange = Math.max(bidRange, askRange, mid * 0.0005);
    const minP = mid - maxRange;
    const maxP = mid + maxRange;

    // 累积计算
    let cumBid = 0;
    const cumBids = bids.filter(b => b.price >= minP).map(b => { cumBid += b.size; return { price: b.price, cum: cumBid }; });
    let cumAsk = 0;
    const cumAsks = asks.filter(a => a.price <= maxP).map(a => { cumAsk += a.size; return { price: a.price, cum: cumAsk }; });
    const maxCum = Math.max(cumBid, cumAsk, 0.0001);

    // 坐标映射
    const padL = 2, padR = 2, padT = 18, padB = 16;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const xOf = p => padL + ((p - minP) / (maxP - minP)) * plotW;
    const yOf = c => padT + plotH - (c / maxCum) * plotH;

    // 背景网格
    ctx.strokeStyle = '#1a2421';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = padT + (plotH / 4) * i;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    }

    // 买盘绿色填充
    ctx.fillStyle = 'rgba(79,209,181,0.15)';
    ctx.strokeStyle = '#4fd1b5';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xOf(mid), padT + plotH);
    cumBids.forEach(b => ctx.lineTo(xOf(b.price), yOf(b.cum)));
    if (cumBids.length) ctx.lineTo(xOf(cumBids[cumBids.length - 1].price), padT + plotH);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 卖盘红色填充
    ctx.fillStyle = 'rgba(240,111,117,0.15)';
    ctx.strokeStyle = '#f06f75';
    ctx.beginPath();
    ctx.moveTo(xOf(mid), padT + plotH);
    cumAsks.forEach(a => ctx.lineTo(xOf(a.price), yOf(a.cum)));
    if (cumAsks.length) ctx.lineTo(xOf(cumAsks[cumAsks.length - 1].price), padT + plotH);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 中间价虚线
    const midX = xOf(mid);
    ctx.strokeStyle = '#4a5752';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(midX, padT);
    ctx.lineTo(midX, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    // 价格轴标签
    ctx.fillStyle = '#4a5752';
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(minP), padL, h - 4);
    ctx.textAlign = 'right';
    ctx.fillText(fmtPrice(maxP), w - padR, h - 4);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#9aaba5';
    ctx.fillText(fmtPrice(mid), midX, 12);

    // 累积量标签
    ctx.fillStyle = '#4a5752';
    ctx.textAlign = 'left';
    ctx.fillText(fmtSize(maxCum), padL + 2, padT + 8);
  }

  function setActive(on) {
    active = on;
    if (on) { ensureCanvas(); resize(); if (lastBook) render(lastBook); }
  }

  return { render, setActive, resize };
})();
