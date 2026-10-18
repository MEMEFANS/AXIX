/* 平台公告横幅：读取 /api/announcement（后台可编辑，最多 2 条），按当前语言显示，每条可单独关闭。
 * 关闭状态按「公告 id + updatedAt」记在 localStorage；后台改了某一条，该条会自动重新出现。
 * 手机端文字超 2 行时折叠，点「展开」弹出详情层，点遮罩 / × / Esc 关闭。 */
(() => {
  const listEl = document.getElementById('platform-announce-list');
  const modal = document.getElementById('platform-announce-modal');
  const modalBody = document.getElementById('pa-modal-body');
  const modalTitle = document.getElementById('pa-modal-title');
  if (!listEl) return;

  const DISMISS_PREFIX = 'platform-announce-dismissed:';
  let data = null;
  let modalItem = null;                 // 当前弹窗展示的公告，语言切换时用它重刷内容
  const banners = new Map();            // id -> { box, textEl, toggleBtn }

  function currentLang() {
    const fromI18n = window.I18n && window.I18n.current;
    if (fromI18n) return fromI18n;
    try { return localStorage.getItem('trade-lang') || 'zh'; } catch { return 'zh'; }
  }
  function isZh() {
    const lang = currentLang();
    return lang === 'zh' || lang === 'zh-TW';
  }
  function pickText(item) {
    if (!item) return '';
    if (isZh()) return item.zh || '';
    return item.en || item.zh || '';
  }
  function isDismissed(item) {
    try { return localStorage.getItem(DISMISS_PREFIX + item.id) === String(item.updatedAt || 0); } catch { return false; }
  }
  function dismiss(item) {
    try { localStorage.setItem(DISMISS_PREFIX + item.id, String(item.updatedAt || 0)); } catch { /* 隐私模式忽略 */ }
  }
  function isMobile() {
    try { return window.matchMedia('(max-width: 700px)').matches; } catch { return false; }
  }
  // 长公告折叠：手机端 1 行、桌面端 3 行；真的溢出才显示「展开」，点横幅文字也能展开
  // 折叠态下 scrollHeight 会被 line-clamp 影响，所以先取消折叠量一次自然高度再比
  function layout(banner) {
    if (banner.box.hidden) return;
    const maxLines = isMobile() ? 1 : 3;
    banner.textEl.classList.remove('is-clamp-1', 'is-clamp-3');
    const naturalHeight = banner.textEl.scrollHeight;
    banner.textEl.classList.add(maxLines === 1 ? 'is-clamp-1' : 'is-clamp-3');
    const overflows = naturalHeight > banner.textEl.clientHeight + 1;
    banner.toggleBtn.hidden = !overflows;
    banner.textEl.classList.toggle('is-tappable', overflows);
    if (overflows) banner.toggleBtn.textContent = isZh() ? '展开' : 'More';
  }
  function openModal(item) {
    if (!modal || !modalBody) return;
    modalItem = item;
    modalBody.textContent = pickText(item);
    if (modalTitle) modalTitle.textContent = isZh() ? '📢 平台公告' : '📢 Announcement';
    modal.hidden = false;
  }
  function closeModal() { if (modal) modal.hidden = true; }
  function bannerFor(item) {
    const cached = banners.get(item.id);
    if (cached) return cached;
    const box = document.createElement('div');
    box.className = 'platform-announce';
    box.innerHTML = `<span class="platform-announce-icon" aria-hidden="true">📢</span>
      <span class="platform-announce-text"></span>
      <button type="button" class="platform-announce-toggle" hidden>展开</button>
      <button type="button" class="platform-announce-close" aria-label="关闭公告">×</button>`;
    const banner = {
      box,
      textEl: box.querySelector('.platform-announce-text'),
      toggleBtn: box.querySelector('.platform-announce-toggle'),
    };
    banner.toggleBtn.addEventListener('click', () => openModal(item));
    // 手机端只有 1 行，点横幅正文也能展开（文字没截断时不响应）
    banner.textEl.addEventListener('click', () => {
      if (banner.textEl.classList.contains('is-tappable')) openModal(item);
    });
    box.querySelector('.platform-announce-close').addEventListener('click', () => {
      dismiss(item);
      box.hidden = true;
      closeModal();
    });
    box.hidden = true;
    listEl.appendChild(box);
    banners.set(item.id, banner);
    return banner;
  }
  function render() {
    const items = (data && Array.isArray(data.items) ? data.items : []).slice(0, 2);
    const visible = items.filter(item => item.enabled !== false && pickText(item) && !isDismissed(item));
    // 先让容器可见再量高度：容器隐藏时子元素量不到真实高度，折叠判断会失效
    listEl.hidden = visible.length === 0;
    for (const item of visible) {
      const banner = bannerFor(item);
      banner.textEl.textContent = pickText(item);
      banner.box.hidden = false;
      layout(banner);
    }
    for (const [id, banner] of banners) {
      if (!visible.some(item => item.id === id)) banner.box.hidden = true;
    }
    if (modal && !modal.hidden && modalItem) openModal(modalItem); // 语言切换时同步弹窗内容
  }

  if (modal) modal.querySelectorAll('[data-pa-close]').forEach(el => el.addEventListener('click', closeModal));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });

  window.addEventListener('languagechange', render);
  function relayoutAll() { banners.forEach(banner => layout(banner)); }
  window.addEventListener('resize', relayoutAll);
  // 首屏渲染可能早于 CSS / 字体就绪，那时量不到真实高度，等加载完再量一次
  window.addEventListener('load', relayoutAll);
  document.fonts?.ready.then(relayoutAll).catch(() => {});
  // i18n 初始化会派发 languagechange；这里额外兜底一次初始渲染
  document.addEventListener('DOMContentLoaded', render, { once: true });

  fetch('/api/announcement', { cache: 'no-store' })
    .then(response => (response.ok ? response.json() : null))
    .then(payload => { data = payload; render(); })
    .catch(() => { /* 公告不可用时不显示，不影响页面 */ });
})();
