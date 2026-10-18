// 订单簿面板 tab 切换模块：订单簿 / 最近成交 / 深度图
window.TradeBookTabs = (() => {
  let active = 'book';

  function setActive(view) {
    active = view;
    document.querySelectorAll('#trade-book-tabs button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.bookView === view);
    });
    ['book', 'trades', 'depth'].forEach(v => {
      const panel = document.getElementById(`trade-${v === 'book' ? 'book' : v === 'trades' ? 'trades' : 'depth'}-panel`);
      if (panel) panel.hidden = v !== view;
    });
    window.TradeTrades?.setActive(view === 'trades');
    window.TradeDepth?.setActive(view === 'depth');
    if (view === 'trades') window.TradeTrades?.refresh();
    if (view === 'depth') window.TradeDepth?.resize();
  }

  function init() {
    document.querySelectorAll('#trade-book-tabs button').forEach(btn => {
      btn.onclick = () => setActive(btn.dataset.bookView);
    });
  }

  return { get active() { return active; }, setActive, init };
})();
