import { PlayerProfile } from '../run-aix/player-profile.js?v=20261028c';
import { HashSession } from '../hash-aix/core.js?v=20261028c';
import { WebsiteSession } from '../run-aix/session.js?v=20261028b';

const $ = id => document.getElementById(id);
const STORE = 'aix-play:lobby:v1';
const catalog = [
  { id: 'runner', title: '奔跑吧 AIX', english: 'COSMIC RUNNER', category: 'adventure', label: '动作冒险', badge: 'AIX 押注', image: '/games/run-aix/assets/hub-v4.jpg', href: '/run-aix.html', desc: 'AIX 押注起跑的星际航线：开跑就返 0.3 倍，1000 米保本，收益封顶保本。', tags: ['单人闯关', '押注挑战'], glyph: '↗', odds: [['0.3×', ' 开跑即返'], ['1.0×', ' 1000 米保本'], ['保本', ' 收益封顶']] },
  { id: 'hash', title: '哈希星盘', english: 'HASH ORBIT', category: 'quick', label: '轻量休闲', badge: 'AIX 押注', image: '/games/hash-aix/assets/hash-core.jpg', href: '/hash-aix.html', desc: '单双大小，押 AIX 猜哈希末位。先承诺后揭晓，每局可验算。', tags: ['单双 / 大小', '结果可核验'], glyph: '✦', odds: [['1.98×', ' 猜中'], ['SHA-256', ' 可核验']] },
];
const ids = new Set(catalog.map(game => game.id));
let state = { favorites: [], visits: [] }, category = 'all', query = '', view = 'discover', toastTimer;
let serverRun = null, serverHash = null, wallet = { status: 'loading' };
let storageAvailable = true, runnerData = null, runnerStars = 0, hashData = null, hashError = false, progressRequest = 0;
function clean(value) {
  return { favorites: Array.isArray(value?.favorites) ? [...new Set(value.favorites.filter(id => ids.has(id)))] : [], visits: Array.isArray(value?.visits) ? value.visits.filter(v => ids.has(v?.id) && Number.isSafeInteger(v.at) && v.at > 0 && v.at <= Date.now() + 60000).slice(0, 10).map(v => ({ id: v.id, at: v.at })) : [] };
}
function read() { try { state = clean(JSON.parse(localStorage.getItem(STORE) || 'null')); } catch { storageAvailable = false; } }
function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { storageAvailable = false; notice(); } }
function notice() { $('storage-notice').hidden = storageAvailable; $('storage-notice').textContent = '浏览器存档不可用，收藏与最近打开仅保留在当前页面。'; }
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function svg(id) { const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = document.createElementNS(node.namespaceURI, 'use'); use.setAttribute('href', `#${id}`); node.append(use); return node; }
function toast(text) { clearTimeout(toastTimer); $('lobby-toast').textContent = text; $('lobby-toast').hidden = false; toastTimer = setTimeout(() => { $('lobby-toast').hidden = true; }, 2200); }
function visit(id) { if (!ids.has(id)) return; state.visits = [{ id, at: Date.now() }, ...state.visits.filter(v => v.id !== id)].slice(0, 10); save(); }
function link(game, className, text, href = game.href) { const a = element('a', className, text); a.href = href; a.dataset.gameLink = game.id; return a; }
function card(game, index = 0) {
  const article = element('article', `game-card game-card-${game.id}`);
  article.style.setProperty('--i', String(index));
  const cover = link(game, 'game-cover'); cover.setAttribute('aria-label', `打开${game.title}`);
  const image = element('img'); image.src = game.image; image.alt = game.id === 'runner' ? '浮空城市中的星际跑道' : '紫色晶体与金属星盘'; image.loading = 'eager';
  const veil = element('span', 'cover-veil'); veil.append(element('span', 'veil-play', '▶'), element('span', 'veil-text', '进入游戏'));
  cover.append(image, element('span', 'cover-label', game.english), element('span', 'cover-badge', game.badge), veil, element('span', 'cover-arrow', game.glyph));
  const favorite = element('button', 'favorite-button'); favorite.type = 'button'; const active = state.favorites.includes(game.id); favorite.setAttribute('aria-label', `${active ? '取消收藏' : '收藏'}${game.title}`); favorite.setAttribute('aria-pressed', String(active)); favorite.dataset.favorite = game.id; favorite.append(svg('i-star')); favorite.classList.toggle('selected', active);
  const body = element('div', 'game-card-body'), heading = element('div', 'card-heading'); heading.append(link(game, '', game.title), element('span', '', game.label));
  const desc = element('p', '', game.desc), foot = element('div', 'card-foot'), tags = element('div', 'game-tags'); for (const tag of game.tags) tags.append(element('span', '', tag));
  const play = link(game, 'play-link', '开始游戏'); play.setAttribute('aria-label', `开始游戏：${game.title}`); play.append(svg('i-arrow'));
  foot.append(tags, play); body.append(heading, desc);
  if (game.id === 'runner') { const progress = element('div', 'card-progress'); const bar = element('span'); bar.append(element('i')); progress.append(bar, element('b', '', '0 / 1 关')); body.append(progress); }
  body.append(foot); article.append(cover, favorite, body); return article;
}
// 把本机真实通关进度画在卡片上；进度异步到位时二次刷新，不重建整张卡片。
function paintProgress() {
  const played = runnerData ? Object.keys(runnerData.completed).length : 0;
  for (const node of document.querySelectorAll('.game-card-runner .card-progress')) {
    node.querySelector('i').style.width = `${Math.min(100, played / 1 * 100)}%`;
    node.querySelector('b').textContent = `${played} / 1 关`;
  }
}
// 精选滑轨大卡：整卡可点，Steam 胶囊式封面主视觉。
function railCard(game) {
  const a = link(game, `rail-card rail-card-${game.id}`); a.setAttribute('aria-label', `打开${game.title}`);
  const image = element('img'); image.src = game.image; image.alt = ''; image.loading = 'eager'; image.draggable = false;
  const body = element('div', 'rail-body');
  body.append(element('span', 'rail-kicker', `${game.label} · ${game.english}`), element('h3', '', game.title), element('p', '', game.desc));
  const actions = element('div', 'rail-actions'); actions.append(element('span', 'rail-play', game.id === 'runner' ? '▶ 立即开跑' : '✦ 立即开局'), element('span', 'rail-tag', game.badge));
  const odds = element('span', 'rail-odds'); for (const [value, label] of game.odds) { const chip = element('span'); chip.append(element('b', '', value), document.createTextNode(label)); odds.append(chip); }
  body.append(odds, actions); a.append(image, element('span', 'rail-shade'), element('span', 'rail-shine'), body); return a;
}
function soonTile() { const tile = element('div', 'soon-tile'); tile.append(element('span', '', '✦'), element('b', '', '更多游戏开发中'), element('p', '', '新的星际挑战正在路上，敬请期待。')); return tile; }
function renderCards() {
  const shown = catalog.filter(g => (category === 'all' || g.category === category) && `${g.title} ${g.english} ${g.desc} ${g.label}`.toLowerCase().includes(query));
  $('rail-featured').replaceChildren(...catalog.map(railCard), soonTile());
  $('game-grid').replaceChildren(...shown.map((game, index) => card(game, index))); $('catalog-empty').hidden = shown.length > 0;
  const favorites = catalog.filter(g => state.favorites.includes(g.id)); $('favorite-grid').replaceChildren(...favorites.map((game, index) => card(game, index))); $('favorites-empty').hidden = favorites.length > 0;
  $('clear-search').hidden = !query;
  paintProgress();
}
function renderJourney() {
  const last = state.visits[0], game = last && catalog.find(g => g.id === last.id);
  const resume = $('resume-card'); resume.replaceChildren();
  if (game) {
    const image = element('img'); image.src = game.image; image.alt = '';
    const copy = element('div'); copy.append(element('small', '', '上次打开'), element('b', '', game.title)); const a = link(game, 'resume-link', '继续游玩 ↗'); resume.append(image, copy, a);
  } else {
    resume.append(element('span', 'resume-glyph', '✧'), element('b', '', '还没有最近游戏'), element('p', '', '点击游戏卡片，即可开始。'), element('a', 'resume-discover', '选择游戏 ↗')); resume.lastChild.href = '#catalog';
  }
  const played = runnerData ? Object.keys(runnerData.completed).length : 0;
  const rows = [[catalog[0], `${played} / 1 关`, played / 1], [catalog[1], serverHash ? `${serverHash.stats?.bets || 0} 局押注` : hashError ? '存档待检查' : `${hashData?.stats?.played || 0} 局参与`, null]];
  $('journey-stats').replaceChildren(...rows.map(([g, value, progress]) => {
    const row = element('div', 'journey-stat'), head = element('div'); head.append(element('span', '', g.title), element('b', '', value)); row.append(head);
    if (progress !== null) { const bar = element('div', 'journey-progress'), fill = element('span'); fill.style.width = `${progress * 100}%`; bar.append(fill); row.append(bar); }
    else row.append(element('small', '', serverHash ? 'AIX 押注 · 平台记录' : '登录后显示平台记录'));
    return row;
  }));
}
function renderActivity() {
  const stats = [
    ['奔跑吧 AIX', '通关进度', `${runnerData ? Object.keys(runnerData.completed).length : 0} / 1`, `已获得 ${runnerStars} 颗星`, '/run-aix.html#records', catalog[0]],
    serverHash
      ? ['哈希星盘', '已押注回合', String(serverHash.stats?.bets || 0), `近 ${serverHash.stats?.recentBets || 0} 局命中 ${serverHash.stats?.wins || 0} 局`, '/hash-aix.html#history', catalog[1]]
      : ['哈希星盘', '已参与回合', hashError ? '—' : String(hashData?.stats?.played || 0), hashError ? '存档待检查，请进入游戏查看' : `命中 ${hashData?.stats?.wins || 0} 局`, '/hash-aix.html#history', catalog[1]],
  ];
  $('activity-stats').replaceChildren(...stats.map(([name, label, value, detail, href, game]) => { const panel = element('article'); panel.append(element('span', 'eyebrow', name), element('p', '', label), element('strong', '', value), element('small', '', detail), link(game, '', '查看完整记录 ↗', href)); return panel; }));
  $('recent-list').replaceChildren(...state.visits.map(v => { const game = catalog.find(g => g.id === v.id), row = element('div', 'recent-row'), image = element('img'); image.src = game.image; image.alt = ''; const text = element('div'); text.append(element('b', '', game.title), element('small', '', `上次打开 · ${new Date(v.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`)); row.append(image, text, link(game, 'button-subtle', '继续玩 ↗')); return row; }));
  if (!state.visits.length) { const empty = element('div', 'empty-state'); empty.append(element('span', '', '⌁'), element('h3', '', '还没有打开过游戏'), element('p', '', '从大厅选一款，旅程就开始了。')); $('recent-list').append(empty); }
}
function route(event) {
  const hash = location.hash.slice(1); view = ['discover', 'library', 'activity', 'guide'].includes(hash) ? hash : 'discover';
  for (const page of document.querySelectorAll('.lobby-view')) page.hidden = page.id !== `view-${view}`;
  // 同时点亮侧边栏（旧）和 Steam 顶栏 tab（新），两类 DOM 都在所以都要照顾。
  for (const selector of ['.side-nav a', '.mobile-nav a', '.steam-tabs .steam-tab']) {
    for (const a of document.querySelectorAll(selector)) {
      const active = a.hash === `#${view}`;
      a.classList.toggle('active', active);
      active ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
    }
  }
  const crumb = $('breadcrumb-current'); if (crumb) crumb.textContent = { discover: '游戏大厅', library: '我的收藏', activity: '游玩记录', guide: '新手指南' }[view];
  if (event?.type === 'hashchange') $('lobby-main').focus({ preventScroll: true });
  if (hash === 'catalog') requestAnimationFrame(() => $('catalog').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })); else window.scrollTo({ top: 0, behavior: 'instant' });
}
async function loadProgress() {
  const request = ++progressRequest, profile = new PlayerProfile();
  const hash = new HashSession(); const result = await hash.ready();
  if (request !== progressRequest) return;
  runnerData = profile.data; runnerStars = profile.stars; hashError = !result.ok; hashData = result.ok ? hash.data : null;
  renderJourney(); renderActivity(); paintProgress();
}
document.addEventListener('click', event => {
  const favorite = event.target.closest('[data-favorite]');
  if (favorite) { const id = favorite.dataset.favorite; if (!ids.has(id)) return; const active = state.favorites.includes(id); state.favorites = active ? state.favorites.filter(v => v !== id) : [...state.favorites, id]; save(); renderCards(); const grid = view === 'library' ? 'favorite-grid' : 'game-grid'; const replacement = document.querySelector(`#${grid} [data-favorite="${id}"]`) || document.querySelector(`#${grid} [data-favorite]`) || $('favorites-empty').querySelector('a'); replacement?.focus({ preventScroll: true }); toast(active ? '已取消收藏' : '已收藏到「我的收藏」'); return; }
  const a = event.target.closest('a[data-game-link]'); if (a && !event.defaultPrevented) visit(a.dataset.gameLink);
});
for (const button of document.querySelectorAll('[data-category]')) button.onclick = () => { category = button.dataset.category; for (const item of document.querySelectorAll('[data-category]')) { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); } renderCards(); };
$('game-search').oninput = event => { query = event.target.value.trim().toLowerCase(); renderCards(); };
$('clear-search').onclick = () => { $('game-search').value = ''; query = ''; renderCards(); $('game-search').focus(); };
$('reset-search').onclick = () => { category = 'all'; query = ''; $('game-search').value = ''; for (const button of document.querySelectorAll('[data-category]')) { const active = button.dataset.category === 'all'; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); } renderCards(); };
for (const exit of document.querySelectorAll('[data-exit-lobby]')) exit.onclick = event => { if (window.parent !== window) { event.preventDefault(); window.parent.postMessage({ type: 'aix-games:close' }, location.origin); } };
window.addEventListener('hashchange', route);
window.addEventListener('storage', event => { if (event.key === STORE || event.key === null) { read(); renderCards(); renderJourney(); renderActivity(); } if (event.key === 'run-aix:player-profile:v1' || event.key === 'hash-aix:local:v1' || event.key === null) loadProgress(); });
window.addEventListener('pageshow', event => { if (event.persisted) { read(); renderCards(); loadProgress(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadProgress(); });
// 入场仪式：先亮一次 AIX PLAY 启动画面，再淡出到大厅，避免"网页仪表盘"的观感。
const boot = $('lobby-boot');
if (boot) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) boot.remove();
  else setTimeout(() => { boot.classList.add('done'); setTimeout(() => boot.remove(), 460); }, 620);
}
// —— 游戏厅：精选轮播 ——
const slides = [...document.querySelectorAll('.ph-slide')], dots = [...document.querySelectorAll('[data-dot]')];
let slide = 0, slideTimer = 0;
function showSlide(next, user = false) {
  slide = (next + slides.length) % slides.length;
  slides.forEach((node, i) => {
    const active = i === slide; node.classList.toggle('active', active); node.setAttribute('aria-hidden', String(!active));
    for (const a of node.querySelectorAll('a')) a.tabIndex = active ? 0 : -1;
  });
  dots.forEach((dot, i) => { dot.setAttribute('aria-selected', String(i === slide)); dot.classList.toggle('active', i === slide); });
  clearTimeout(slideTimer);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) slideTimer = setTimeout(() => showSlide(slide + 1), user ? 12000 : 6500);
}
for (const dot of dots) dot.onclick = () => showSlide(Number(dot.dataset.dot), true);
const hero = $('play-hero');
if (hero) {
  hero.addEventListener('pointerenter', () => clearTimeout(slideTimer));
  hero.addEventListener('pointerleave', () => showSlide(slide));
  let touchX = null;
  hero.addEventListener('touchstart', event => { touchX = event.touches[0].clientX; }, { passive: true });
  hero.addEventListener('touchend', event => { if (touchX === null) return; const dx = event.changedTouches[0].clientX - touchX; touchX = null; if (Math.abs(dx) > 40) showSlide(slide + (dx < 0 ? 1 : -1), true); });
}
// —— 卡片 3D 倾斜 + 高光（仅精细指针、未开减少动态）——
if (matchMedia('(pointer: fine)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.addEventListener('pointermove', event => {
    const cardNode = event.target.closest?.('.rail-card'); if (!cardNode) return;
    const rect = cardNode.getBoundingClientRect(), x = (event.clientX - rect.left) / rect.width - .5, y = (event.clientY - rect.top) / rect.height - .5;
    cardNode.style.setProperty('--rx', `${(-y * 6).toFixed(2)}deg`); cardNode.style.setProperty('--ry', `${(x * 8).toFixed(2)}deg`);
    cardNode.style.setProperty('--mx', `${((x + .5) * 100).toFixed(1)}%`); cardNode.style.setProperty('--my', `${((y + .5) * 100).toFixed(1)}%`);
  });
  document.addEventListener('pointerout', event => { const cardNode = event.target.closest?.('.rail-card'); if (cardNode && !cardNode.contains(event.relatedTarget)) { cardNode.style.removeProperty('--rx'); cardNode.style.removeProperty('--ry'); } });
}
// —— 玩家条与战绩：只读平台真实数据，不虚构玩家或战绩 ——
const fmt = (value, digits = 2) => { const n = Number(value); return Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—'; };
function requestLogin() {
  try { if (window.parent !== window) { window.parent.postMessage({ type: 'aix-games:login' }, location.origin); toast('请在打开的登录面板完成钱包登录'); return; } } catch { /* 独立窗口回退首页 */ }
  location.href = '/';
}
function renderPlayer() {
  const chip = $('player-chip'); if (!chip) return;
  const ready = wallet.status === 'ready';
  chip.classList.toggle('ready', ready);
  $('pc-label').textContent = ready ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : '玩家';
  $('pc-balance').textContent = ready ? `${fmt(wallet.balance)} AIX` : wallet.status === 'loading' ? '检测登录…' : wallet.status === 'unavailable' ? '平台未连接' : '登录开玩 ↗';
}
function tile(label, value, unit, note, tone = '') {
  const node = element('div', `ps-tile ${tone}`); const big = element('b', '', value); if (unit) big.append(element('small', '', unit));
  node.append(element('span', '', label), big, element('small', 'ps-note', note)); return node;
}
function renderStats() {
  const tiles = $('ps-tiles'), feed = $('ps-feed'); if (!tiles) return;
  if (wallet.status !== 'ready') {
    tiles.replaceChildren(tile('钱包余额', '—', '', '登录后显示', 'gold'), tile('跑酷最远', '—', '', '登录后显示'), tile('星盘命中', '—', '', '登录后显示'), tile('可卖额度', '—', '', '流水 1% 累计', 'mint'));
    const cta = element('button', 'ps-login', wallet.status === 'loading' ? '正在检测登录…' : '登录钱包，记录你的每一局 ↗'); cta.type = 'button'; cta.onclick = requestLogin;
    feed.replaceChildren(cta); return;
  }
  const runs = (serverRun?.recentRuns || []).filter(run => run.status !== 'pending');
  const best = runs.reduce((max, run) => Math.max(max, Number(run.distance) || 0), 0);
  const hs = serverHash?.stats || {};
  const quota = serverRun?.sellQuota || serverHash?.sellQuota;
  tiles.replaceChildren(
    tile('钱包余额', fmt(wallet.balance), ' AIX', '平台 AIX 余额', 'gold'),
    tile('跑酷最远', runs.length ? String(best) : '—', runs.length ? ' m' : '', runs.length ? `近 ${runs.length} 局 · 共 ${serverRun?.runs || 0} 局` : '还没跑过，去试试'),
    tile('星盘命中', hs.recentBets ? `${Math.round(hs.wins / hs.recentBets * 100)}` : '—', hs.recentBets ? '%' : '', hs.recentBets ? `近 ${hs.recentBets} 局命中 ${hs.wins} 局` : '还没开过局'),
    tile('可卖额度', quota ? fmt(quota.availableA) : '—', quota ? ' AIX' : '', '流水 1% 自动累计', 'mint'),
  );
  const events = [
    ...runs.map(run => ({ at: run.settledAt || run.startedAt, text: `跑酷 ${run.distance} m`, detail: `押 ${fmt(run.stakeA)} → 返 ${fmt(run.payoutA)}`, up: Number(run.payoutA) >= Number(run.stakeA) })),
    ...(serverHash?.recent || []).map(bet => ({ at: bet.createdAt, text: `星盘 ${{ odd: '单', even: '双', small: '小', big: '大' }[bet.choice] || ''} · 开 ${String(bet.hexDigit).toUpperCase()}`, detail: bet.won ? `命中 +${fmt(bet.netA)}` : `未中 -${fmt(bet.stakeA)}`, up: bet.won })),
  ].sort((a, b) => b.at - a.at).slice(0, 10);
  if (!events.length) { feed.replaceChildren(element('span', 'ps-empty', '还没有战绩，选一款游戏开始第一局吧。')); return; }
  feed.replaceChildren(...events.map(item => { const node = element('span', `ps-event ${item.up ? 'up' : 'down'}`); node.append(element('b', '', item.text), element('small', '', item.detail)); return node; }));
}
async function loadServerStats() {
  if (wallet.status !== 'ready') { serverRun = serverHash = null; renderStats(); renderJourney(); renderActivity(); return; }
  const get = url => fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  [serverRun, serverHash] = await Promise.all([get('/api/run-aix/state'), get('/api/hash-aix/state')]);
  renderStats(); renderJourney(); renderActivity();
}
$('player-chip')?.addEventListener('click', () => { if (wallet.status !== 'ready') requestLogin(); else location.hash = 'activity'; });
const walletSession = new WebsiteSession(next => {
  const changed = next.status !== wallet.status || next.address !== wallet.address;
  wallet = next; renderPlayer();
  if (changed) loadServerStats(); else renderStats();
});
read(); notice(); renderCards(); renderJourney(); renderActivity(); route(); loadProgress();
renderPlayer(); renderStats(); showSlide(0); walletSession.start();
