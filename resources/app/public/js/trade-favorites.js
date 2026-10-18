// 自选收藏模块：localStorage 持久化 + 星标渲染
window.TradeFavorites = (() => {
  const KEY = 'trade-favorites';

  function list() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
  }

  function save(arr) {
    try { localStorage.setItem(KEY, JSON.stringify(arr)); } catch {}
  }

  function isFavorite(symbol) {
    const s = String(symbol || '').toUpperCase();
    return list().includes(s);
  }

  function toggle(symbol) {
    const s = String(symbol || '').toUpperCase();
    const arr = list();
    const idx = arr.indexOf(s);
    if (idx >= 0) arr.splice(idx, 1); else arr.push(s);
    save(arr);
  }

  function renderStar(symbol) {
    const fav = isFavorite(symbol);
    return `<button class="market-favorite-btn${fav ? ' active' : ''}" data-favorite="${symbol}" type="button" aria-pressed="${fav}" onclick="event.stopPropagation()">★</button>`;
  }

  return { list, isFavorite, toggle, renderStar };
})();
