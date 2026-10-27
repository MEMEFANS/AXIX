import { CampaignEngine } from './campaign-engine.js?v=20261027c';
import { LEVELS, WORLDS, getLevel } from './campaign.js?v=20261027c';
import { PlayerProfile, SKINS, ACHIEVEMENTS, PROFILE_STORAGE_KEY } from './player-profile.js';
import { WebsiteSession } from './session.js';
import { GameArt } from './art.js?v=20261027b';
import { GameAudio } from './audio.js';
import { artReady } from './sprites.js?v=20261027b';
import { WAGER, wagerPercent, nextStep } from './wager.js?v=20261027b';

const $ = id => document.getElementById(id);
const profile = new PlayerProfile();
try { if (!localStorage.getItem(PROFILE_STORAGE_KEY) && matchMedia('(prefers-reduced-motion: reduce)').matches) profile.setSetting('reducedMotion', true); } catch { /* Session settings remain available without storage. */ }
const audio = new GameAudio();
const art = new GameArt($('world'));
const pictures = ['city-v2.jpg', 'exchange-v2.jpg', 'ocean-v2.jpg'];
const worldEnglish = ['COSMIC CITY', 'EXCHANGE HALL', 'STABLE OCEAN'];
const filters = { aurora: 'none', nebula: 'hue-rotate(65deg) saturate(.9)', sunrise: 'hue-rotate(195deg) saturate(.8)' };
const descriptions = ['第一道极光，陪你踏上旅程。', '青蓝星云，献给不断前行的你。', '晨曦金光，为你的勇气闪耀。'];
const symbols = ['✦', '⚑', '✧', '★', '◇', '◎', '≋'];
let engine = null, activeLevel = null;
let previous = 0, animation = 0, bannerTimer, toastTimer, resultTimer;
let primaryAction, secondaryAction, returnFocus = null, currentView = 'home';
let swipe = null, starting = false;
// —— AIX 押注经济（2026-10-27）：登录 + 自选押注 + 服务端种子回放结算 ——
const PENDING_SETTLE_KEY = 'run-aix:pending-settle';
const LAST_STAKE_KEY = 'run-aix:last-stake';
const TRACE_MAX_FRAMES = 40000; // 与服务端 TRACE_MAX_FRAMES 一致
let walletState = { status: 'guest' };
let activeRun = null;        // { runId, stakeA, commitment }：本局押注凭证
let lastSettlement = null;   // 最近一次结算响应（结果弹窗展示）
let pendingInputs = [];      // 本帧积累的输入指令（回放日志）
let traceFrames = [];        // 逐帧 [dt 秒, 输入[]]，结算时交服务端回放
let settleRetryTimer = null;
// 押注局的随机数不再由种子本地生成，而是服务端分段下发的"随机带"：
// 只有把已跑过的帧提交（advance）、服务端回放确认后，才会放出前方的下一段。
const TAPE_SAFE = 16;        // 剩余少于此数即暂停推进等补给（单排障碍最多消耗 ~6 个）
const TAPE_REFILL = 40;      // 剩余少于此数即后台申请下一段
let tape = [], tapeUsed = 0, committedFrames = 0, advancing = false, tapeStalled = false;
const starsText = value => '★'.repeat(value) + '☆'.repeat(3 - value);
const formatTime = seconds => `${Math.max(0, seconds).toFixed(1)} s`;
const chinaDay = (date = Date.now()) => new Date(date + 8 * 3600000).toISOString().slice(0, 10);
const seedFrom = text => [...text].reduce((seed, c) => Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
const seeded = initial => { let value = initial; return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 2 ** 32; }; };
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function image(file, className = '') { const node = element('img', className); node.src = `/games/run-aix/assets/${file}`; node.alt = ''; node.loading = 'lazy'; return node; }
function toast(text) { clearTimeout(toastTimer); $('toast').textContent = text; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800); }
function banner(text, small = true, duration = 1200) {
  clearTimeout(bannerTimer); $('play-banner').textContent = text; $('play-banner').classList.toggle('small', small);
  if (duration) bannerTimer = setTimeout(() => { $('play-banner').textContent = ''; }, duration);
}
// —— 钱包登录与押注结算 ——
function renderWalletChip() {
  const chip = $('wallet-chip'); if (!chip) return;
  chip.classList.toggle('wallet-ready', walletState.status === 'ready');
  if (walletState.status === 'ready') {
    const balance = Number(walletState.balance);
    chip.textContent = `✦ ${Number.isFinite(balance) ? balance.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : walletState.balance} AIX`;
    chip.setAttribute('aria-label', `钱包 AIX 余额 ${chip.textContent}`);
  } else if (walletState.status === 'loading') {
    chip.textContent = '✦ 检测登录…';
  } else if (walletState.status === 'unavailable') {
    chip.textContent = '✦ 平台未连接';
  } else {
    chip.textContent = '✦ 未登录 · 点击登录';
  }
}
function requestLogin() {
  if (walletState.status === 'ready') return;
  try {
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'aix-games:login' }, location.origin);
      toast('请在打开的登录面板完成钱包登录');
      return;
    }
  } catch { /* 独立窗口回退到站内首页 */ }
  location.href = '/';
}
function savePendingSettle(payload) {
  try { localStorage.setItem(PENDING_SETTLE_KEY, JSON.stringify(payload)); } catch { /* 存储不足只能等服务端 30 分钟作废 */ }
}
async function postSettle(payload) {
  const response = await fetch('/api/run-aix/settle', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { data.code = data.code || 'NETWORK'; data.status = response.status; throw data; }
  return data;
}
// 页面关闭/崩溃导致未结算的局，登录后自动补结算
async function recoverPendingSettle() {
  let payload = null;
  try { payload = JSON.parse(localStorage.getItem(PENDING_SETTLE_KEY) || 'null'); } catch { /* 损坏即丢弃 */ }
  if (!payload?.runId || !Array.isArray(payload.frames) || !payload.frames.length) {
    if (payload) { try { localStorage.removeItem(PENDING_SETTLE_KEY); } catch { /* 忽略 */ } }
    return;
  }
  try {
    const data = await postSettle(payload);
    try { localStorage.removeItem(PENDING_SETTLE_KEY); } catch { /* 忽略 */ }
    session.refresh();
    toast(data.expired ? '上局已超时作废（押注不返还）' : `上局已补结算：返还 ${data.payoutA} AIX`);
  } catch (error) {
    // 校验不过/局不存在的日志没有补救价值，直接丢弃；网络错误保留下次再试
    if (SETTLE_FATAL.includes(error?.code)) {
      try { localStorage.removeItem(PENDING_SETTLE_KEY); } catch { /* 忽略 */ }
    }
  }
}
const SETTLE_FATAL = ['VERIFY_FAILED', 'TRACE_INCOMPLETE', 'TRACE_REWRITE', 'CLOCK_AHEAD', 'NOT_FOUND'];
// 随机带取数：押注局只能用服务端已放出的部分
function tapeRandom() {
  if (tapeUsed >= tape.length) throw new Error('随机带未就绪');
  return tape[tapeUsed++] / 2 ** 32;
}
// 提交已跑过的帧，换取前方下一段随机带（同一时刻只发一个请求）
async function requestAdvance() {
  const run = activeRun;
  if (!run || run.dead || advancing) return;
  advancing = true;
  const from = committedFrames;
  try {
    const response = await fetch('/api/run-aix/advance', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: run.runId, from, frames: traceFrames.slice(from), have: tape.length }),
    });
    const data = await response.json().catch(() => ({}));
    if (activeRun !== run) return;
    if (response.status === 409 && Number.isInteger(data.committed)) { committedFrames = Math.min(data.committed, traceFrames.length); return; }
    if (!response.ok) {
      if (['RUN_EXPIRED', 'RUN_CLOSED', 'TRACE_REWRITE', 'CLOCK_AHEAD', 'NOT_FOUND'].includes(data.code)) { run.dead = data.code; toast(data.error || '本局已失效'); }
      return;
    }
    committedFrames = Math.max(committedFrames, Number(data.committed) || 0);
    (data.tape || []).forEach((value, i) => { tape[data.tapeFrom + i] = value >>> 0; });
  } catch { /* 网络抖动：下一帧自动重试 */ }
  finally { advancing = false; }
}
// 结算：上交尚未提交的逐帧日志，服务端用同一随机带回放定距离；失败自动重试后落盘
function settleRun(result) {
  const run = activeRun; if (!run) return;
  // 从 0 整包提交：已提交部分由服务端逐帧比对，避免与在途 advance 的进度竞争
  const payload = { runId: run.runId, distance: Math.floor(result.distance), from: 0, frames: traceFrames.slice() };
  const attempt = retries => {
    postSettle(payload).then(data => {
      lastSettlement = data;
      // 本局已定案：清掉押注凭证，下一局必须重新走 /start，避免残留状态挡住重开
      if (activeRun === run) activeRun = null;
      try { localStorage.removeItem(PENDING_SETTLE_KEY); } catch { /* 忽略 */ }
      session.refresh();
      refreshResultStats(result);
    }).catch(error => {
      if (retries > 0) { settleRetryTimer = setTimeout(() => attempt(retries - 1), 4000); return; }
      if (SETTLE_FATAL.includes(error?.code)) {
        lastSettlement = { stakeA: run.stakeA, payoutA: '0', multiplier: 0, rejected: true };
        refreshResultStats(result);
        toast('结算校验失败，本局押注无法返还');
        return;
      }
      savePendingSettle(payload);
      lastSettlement = null;
      refreshResultStats(result);
      toast('结算暂未完成，已保存待自动重试');
    });
  };
  attempt(3);
}
function refreshResultStats(result) {
  if (!$('game-dialog').open || engine?.result?.id !== result.id) return;
  $('dialog-stats').replaceChildren(...resultNodes(result));
}
function applySettings() {
  const settings = profile.data.settings;
  const reducedMotion = settings.reducedMotion;
  document.body.classList.toggle('reduced-motion', reducedMotion);
  for (const key of ['sound', 'haptics', 'reducedMotion']) $(`setting-${key}`).checked = settings[key];
  if (engine) { engine.reducedMotion = reducedMotion; engine.skinFilter = filters[profile.data.selectedSkin]; }
  audio.enabled = settings.sound; audio.sync();
}
function vibrate(pattern) { if (profile.data.settings.haptics && navigator.vibrate) navigator.vibrate(pattern); }

function updateShell() {
  const data = profile.data, complete = Object.keys(data.completed).length;
  $('journey-summary').textContent = complete ? '航线已开通' : '航线待探索';
  $('star-summary').textContent = `${profile.stars} / 3 颗星`;
  $('continue-adventure').replaceChildren(document.createTextNode(complete === 0 ? '开始冒险' : '重返星际'), element('span', '', '↗'));
}
function worldCard(world) {
  const button = element('button', 'world-card'); button.type = 'button'; button.dataset.world = world.index;
  button.setAttribute('aria-label', `查看${world.title}航段`);
  button.append(image(pictures[world.index]), element('span', 'world-number', `WORLD 0${world.index + 1}`));
  const content = element('div', 'world-content'); content.append(element('small', '', worldEnglish[world.index]), element('h3', '', world.title));
  const bottom = element('div', 'world-bottom'); bottom.append(element('span', '', `第 ${world.index + 1} 段航程 · ${world.subtitle}`), element('span', 'arrow', '↗'));
  content.append(bottom); button.append(content);
  button.onclick = () => { location.hash = 'worlds'; requestAnimationFrame(() => document.getElementById('route')?.scrollIntoView({ block: 'start' })); };
  return button;
}
function renderWorlds() {
  $('home-worlds').replaceChildren(...WORLDS.map(worldCard));
  $('level-map').replaceChildren(...LEVELS.map(level => {
    const chapter = element('section', 'world-chapter'); chapter.id = 'route';
    const head = element('div', 'chapter-heading'); const text = element('div'); text.append(element('h2', '', level.title), element('p', '', level.subtitle));
    head.append(element('span', 'chapter-num', '01'), text); chapter.append(head);
    const levels = element('div', 'chapter-levels');
    const unlocked = profile.isUnlocked(level.id), record = profile.bestScore(level.id);
    const button = element('button', `level-card${unlocked ? '' : ' locked'}`); button.type = 'button'; button.dataset.level = level.id;
    button.disabled = !unlocked; button.setAttribute('aria-label', `${level.title}，${unlocked ? `${level.distance}米，开始挑战` : '暂未开放'}`);
    const detail = element('div'); detail.append(element('h3', '', `01 · ${level.title}`), element('p', '', unlocked ? `${level.distance} m · ${level.subtitle}` : '完成前一关，开启这段旅程。'));
    detail.append(element('span', 'level-stars', record ? starsText(record.stars) : '☆☆☆'));
    button.append(image(pictures[level.world], 'level-art'), detail, element('span', 'level-go', unlocked ? '↗' : '⌑'));
    button.onclick = () => launch(level.id); levels.append(button);
    chapter.append(levels); return chapter;
  }));
}
function renderCollection() {
  $('skin-grid').replaceChildren(...SKINS.map((skin, index) => {
    const unlocked = profile.unlockedSkins.includes(skin.id), selected = profile.data.selectedSkin === skin.id;
    const card = element('article', `skin-card${selected ? ' selected' : ''}`); const art = image('hero-v2.png'); art.style.filter = filters[skin.id];
    const button = element('button', '', selected ? '已装备 ✓' : unlocked ? '装备此装扮' : `${skin.starsRequired} 颗星解锁`); button.disabled = !unlocked || selected; button.dataset.skin = skin.id;
    button.onclick = () => { if (profile.selectSkin(skin.id)) { renderCollection(); toast(`已装备「${skin.name}」`); } };
    card.append(art, element('h2', '', skin.name), element('p', '', descriptions[index]), button); return card;
  }));
  const earned = new Set(profile.achievements.map(a => a.id));
  $('achievement-grid').replaceChildren(...ACHIEVEMENTS.map((achievement, index) => {
    const card = element('article', `achievement${earned.has(achievement.id) ? ' earned' : ''}`); const text = element('div');
    text.append(element('h3', '', achievement.name), element('p', '', achievement.description)); card.append(element('span', '', symbols[index]), text); return card;
  }));
}
function renderRecords() {
  const data = profile.data;
  $('career-stats').replaceChildren(...[['冒险次数', data.totalRuns], ['总计星晶', data.totalCrystals], ['最佳连击', data.bestCombo || 0], ['旅程星数', `${profile.stars} / 3`]].map(([label, value]) => {
    const card = element('div', 'stat-card'); card.append(element('span', '', label), element('b', '', String(value))); return card;
  }));
  $('level-records').replaceChildren(...LEVELS.map(level => {
    const record = profile.bestScore(level.id), row = element('div', 'record-row');
    row.append(element('span', '', level.title), element('span', 'level-stars', starsText(record?.stars || 0)), element('small', 'record-time', record ? formatTime(record.bestTime) : '—'), element('span', '', record ? `${Math.floor(record.bestDistance)} m` : '待探索'));
    return row;
  }));
}
function renderAll() { updateShell(); renderWorlds(); renderCollection(); renderRecords(); applySettings(); }
function route() {
  const next = location.hash.slice(1) || 'home';
  currentView = ['home', 'worlds', 'collection', 'records', 'settings', 'guide'].includes(next) ? next : 'home';
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== `view-${currentView}`;
  for (const link of document.querySelectorAll('.desktop-nav a,.mobile-nav a')) {
    const active = link.hash === `#${currentView}`; link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  if (!engine || !['running', 'countdown', 'paused'].includes(engine.state)) window.scrollTo(0, 0);
}

function closeDialog() { if ($('game-dialog').open) $('game-dialog').close(); }
function showDialog({ kicker, title, copy, stats, primary, action, secondary = '返回大厅', onSecondary = exitGame }) {
  $('dialog-kicker').textContent = kicker; $('dialog-title').textContent = title; $('dialog-copy').textContent = copy;
  $('dialog-stats').replaceChildren(...(stats || []));
  $('dialog-primary').textContent = primary; $('dialog-secondary').textContent = secondary; $('dialog-secondary').hidden = !secondary;
  primaryAction = action; secondaryAction = onSecondary;
  if (!$('game-dialog').open) $('game-dialog').showModal();
  $('dialog-primary').focus();
}
// 换道与暂停都记入回放日志，结算时服务端逐帧重放核对距离
function inputMove(direction) {
  if (engine && engine.state !== 'ended') pendingInputs.push(direction > 0 ? 'm1' : 'm-1');
  engine?.move(direction);
}
function pauseGame() {
  if (engine && ['running', 'countdown'].includes(engine.state)) { pendingInputs.push('p'); engine.pause(); }
}
function exitGame() {
  clearTimeout(resultTimer); clearTimeout(bannerTimer); clearTimeout(settleRetryTimer); closeDialog();
  engine = null; activeLevel = null; activeRun = null; $('play-screen').hidden = true; document.querySelector('.app-shell').inert = false; document.body.classList.remove('game-active');
  renderAll(); route(); audio.suspend(); returnFocus?.focus({ preventScroll: true });
}
function resultNodes(result) {
  const star = element('div', 'result-stars', starsText(result.stars));
  const grid = element('div', 'result-stats');
  for (const [value, label] of [[`${result.distance} m`, '本次距离'], [String(result.nearMisses || 0), '擦身闪避'], [`${formatTime(result.elapsed)} · 连击${result.bestCombo}`, '用时与连击']]) {
    const stat = element('div'); stat.append(element('b', '', value), element('small', '', label)); grid.append(stat);
  }
  const nodes = [star, grid];
  if (lastSettlement) {
    const payout = element('p', 'result-payout');
    payout.textContent = lastSettlement.rejected
      ? `本局押注 ${lastSettlement.stakeA} AIX · 结算校验未通过，押注不返还`
      : `本局押注 ${lastSettlement.stakeA} AIX → 返还 ${lastSettlement.payoutA} AIX（×${lastSettlement.multiplier}）`;
    nodes.push(payout);
  } else if (activeRun) {
    nodes.push(element('p', 'result-payout', `本局押注 ${activeRun.stakeA} AIX · 结算处理中…`));
  }
  const tip = element('p', 'result-tip', result.completed ? '三星通关：地狱航线的完整征服。' : '先巡航看清前方，提前向空车道移动。');
  if (!profile.storageAvailable) tip.textContent += '\n浏览器存档不可用，本次进度仅保留在当前页面。';
  nodes.push(tip);
  return nodes;
}
function presentResult(result) {
  const current = activeLevel;
  showDialog({ kicker: result.completed ? 'A LITTLE BRAVER THAN BEFORE' : 'EVERY TRY IS A NEW BEGINNING',
    title: result.completed ? '航线，抵达！' : '差一点，再试一次',
    copy: result.completed ? (current.id === 'daily' ? '今日航路已完成。再跑一次，挑战更好的表现。' : '1500 米星际航线，从头到尾由你跑完。带着星光，向更好的自己出发。') : '撞上了。地狱航线只给一条命，再来。',
    stats: resultNodes(result), primary: '再试一次 ↻',
    action: () => launch(current.id) });
}
function onEvent(name, data) {
  audio.effect(name, data);
  if (name === 'countdown') banner(data > 0 ? String(data) : 'GO', false, 0);
  if (name === 'go') banner('出发！', true, 850);
  if (name === 'nearMiss') { vibrate([10, 16, 10]); if (data.combo >= 5) banner(`擦身连击 ${data.combo} ✦`, true, 550); }
  if (name === 'pause') {
    audio.suspend(); showDialog({ kicker: 'TAKE A BREATH', title: '星光会等你', copy: '旅程已暂停，准备好了再出发。', primary: '继续冒险 ↗', action: () => { closeDialog(); if (engine && engine.state === 'paused') pendingInputs.push('r'); engine?.resume(); previous = performance.now(); audio.resume(); } });
  }
  if (name === 'end') {
    banner('', true, 0);
    // A daily expedition belongs to the day its route was created, including
    // runs paused over midnight. Keep the engine's actual completion timestamp.
    const record = activeLevel.id === 'daily' ? { ...data, date: activeLevel.dailyStartedAt } : data;
    const stored = profile.recordRun(record);
    if (!stored.ok) toast('本次成绩未能保存');
    audio.effect(data.completed ? 'win' : 'lose');
    if (activeRun) settleRun(data);
    clearTimeout(resultTimer); resultTimer = setTimeout(() => { if (engine?.result?.id === data.id) presentResult(data); }, data.completed ? 300 : 800);
  }
}
async function launch(id) {
  if (starting) return toast('正在准备上一局，请稍候…');
  if (LEVELS.some(level => level.id === id) && !profile.isUnlocked(id)) return toast('完成前一关，开启下一段旅程。');
  clearTimeout(resultTimer); clearTimeout(settleRetryTimer);
  // 登录门槛：平台接口不可用（纯静态预览）时退化为不计资产的本地试玩
  if (walletState.status === 'ready') return promptStake(id);
  if (walletState.status === 'loading') return toast('正在确认登录状态，稍候再试');
  if (walletState.status === 'unavailable') return beginRun(id, null);
  showDialog({ kicker: 'WALLET REQUIRED', title: '登录后押注起跑', copy: '星际航线已接入平台 AIX：自选押注，开跑即返 0.3 倍，1000 米保本，1500 米通关 5 倍；流水 1% 自动转可卖额度。', primary: '去登录 ↗', action: () => { closeDialog(); requestLogin(); }, secondary: '暂不出发', onSecondary: exitGame });
}
async function fetchRunState() {
  try {
    const response = await fetch('/api/run-aix/state', { credentials: 'same-origin', cache: 'no-store' });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}
async function promptStake(id, retried = false) {
  if (starting) return toast('正在准备上一局，请稍候…');
  starting = true;
  const state = await fetchRunState();
  starting = false;
  if (state?.pendingRun) {
    if (!retried) {
      // 上一局多半只是结算在途：先补一次结算再重试，避免直接被锁 30 分钟
      await recoverPendingSettle();
      return promptStake(id, true);
    }
    return showDialog({
      kicker: 'PREVIOUS RUN', title: '上一局还没结算完',
      copy: '最后一次结算没有完成。可以点下方立即重试；超过 30 分钟会自动作废，并按跑到的距离返还。',
      primary: '重试结算 ↗',
      action: () => { closeDialog(); recoverPendingSettle().then(() => launch(id)); },
      secondary: '返回大厅', onSecondary: exitGame,
    });
  }
  const balance = state?.balanceA || walletState.balance || '0';
  const input = element('input', 'stake-input');
  input.type = 'number'; input.min = state?.minStakeA || '0.1'; input.step = '0.1';
  input.max = String(Math.min(Number(state?.maxStakeA || 10000), Number(balance) || 10000));
  input.placeholder = '0.1'; input.setAttribute('inputmode', 'decimal'); input.setAttribute('aria-label', '本局押注金额（AIX）');
  let lastStake = '';
  try { lastStake = localStorage.getItem(LAST_STAKE_KEY) || ''; } catch { /* 无存储时用默认值 */ }
  input.value = lastStake && Number(lastStake) > 0 ? lastStake : '1';
  // 快捷筹码：点选直接填入押注额；输入框手动改动时同步高亮
  const chips = element('div', 'stake-chips');
  const CHIP_VALUES = [1, 10, 20, 40, 80, 160, 320];
  const chipButtons = CHIP_VALUES.map(value => {
    const chip = element('button', 'stake-chip');
    chip.type = 'button'; chip.textContent = String(value);
    chip.setAttribute('aria-label', `快捷押注 ${value} AIX`);
    chip.onclick = () => { input.value = String(value); syncChips(); };
    chips.appendChild(chip);
    return chip;
  });
  const syncChips = () => chipButtons.forEach((chip, i) => chip.classList.toggle('selected', Number(input.value) === CHIP_VALUES[i]));
  input.addEventListener('input', syncChips);
  syncChips();
  const hint = element('p', 'stake-hint');
  hint.textContent = `钱包余额 ${balance} AIX · 押注 0.1 – 10000 AIX\n开跑即返 0.3 倍 · 1000 米保本 1.0 · 1200 米 2.0 · 1500 米通关 5.0 倍\n流水 1% 自动转 AIX 可卖额度`;
  showDialog({ kicker: 'WAGER · 押注起跑', title: '押上 AIX，冲进地狱航线', copy: '按最终距离结算，服务端回放全程操作核定成绩。', stats: [input, chips, hint], primary: '支付押注 · 起跑 ↗', action: () => confirmStake(id, input), secondary: '暂不出发', onSecondary: exitGame });
}
async function confirmStake(id, input) {
  const stakeA = String(input.value || '').trim();
  if (!Number.isFinite(Number(stakeA)) || Number(stakeA) <= 0) return toast('请输入押注金额');
  const primary = $('dialog-primary'); primary.disabled = true;
  try {
    const response = await fetch('/api/run-aix/start', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stakeA, levelId: id }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '押注失败，请重试');
    activeRun = { runId: data.runId, stakeA: data.stakeA, commitment: data.commitment, tape: (data.tape || []).map(v => v >>> 0) };
    try { localStorage.setItem(LAST_STAKE_KEY, stakeA); } catch { /* 无存储不影响押注 */ }
    closeDialog();
    beginRun(id, activeRun);
  } catch (error) {
    toast(error.message || '押注失败，请重试');
    primary.disabled = false;
    session.refresh();
  }
}
async function beginRun(id, run) {
  if (starting) return;
  starting = true; closeDialog();
  lastSettlement = null; pendingInputs = []; traceFrames = [];
  tape = run?.tape ? run.tape.slice() : []; tapeUsed = 0; committedFrames = 0; advancing = false; tapeStalled = false; shownPercent = 0;
  let level = getLevel(id), random = Math.random;
  if (id === 'daily') {
    const dailyStartedAt = Date.now(), day = chinaDay(dailyStartedAt);
    level = { ...getLevel('level-1'), id: 'daily', title: '每日远征', subtitle: day, dailyStartedAt, world: seedFrom(day) % 3 };
    // 免费试玩沿用全服同日航路；押注局每局独立随机带
    random = run ? tapeRandom : seeded(seedFrom(`aix-daily:${day}`));
  } else if (run) {
    random = tapeRandom;
  }
  if (!level) { starting = false; return; }
  if (!engine) returnFocus = document.activeElement;
  engine = null; activeLevel = level;
  $('play-screen').hidden = false; document.body.classList.add('game-active'); document.querySelector('.app-shell').inert = true;
  $('play-title').textContent = level.title; $('play-world').textContent = id === 'daily' ? `${level.subtitle} · 每日远征` : '星空之城 → 交易所大厅 → 稳定币海域';
  $('play-target').textContent = ` / ${level.distance} m`; $('play-coach').textContent = '自动奔跑 · 左右滑动或点按换道 · 越跑越快';
  const stakeBadge = $('play-stake');
  if (stakeBadge) { stakeBadge.hidden = !run; stakeBadge.textContent = run ? `✦ 押注 ${run.stakeA} AIX` : ''; }
  banner('准备航路', true, 0);
  try {
    await artReady;
    engine = new CampaignEngine({ level, random, onEvent }); applySettings();
    art.resize(); previous = performance.now(); engine.start();
    $('world').focus({ preventScroll: true }); audio.resume();
  } catch (error) {
    console.error('Adventure start failed', error); exitGame(); toast('航路加载失败，请刷新页面重试。');
  } finally { starting = false; }
}
function updateHud() {
  $('play-distance').textContent = Math.floor(engine.distance);
  $('play-hearts').textContent = '♥ '.repeat(engine.hearts).trim() + ' ♡'.repeat(engine.maxHearts - engine.hearts);
  $('play-hearts').setAttribute('aria-label', `剩余${engine.hearts}颗心`);
  $('route-fill').style.width = `${engine.distance / engine.rules.maxDistance * 100}%`;
  $('play-combo').textContent = engine.combo >= 2 ? `连击 ${engine.combo} ✦` : engine.distance < 40 ? '从容出发' : '看清落点，提前换道';
  $('play-speed').textContent = `${engine.speed.toFixed(0)} m/s`;
  $('play-coach').hidden = engine.distance > 85;
  updateReturnHud();
}
// 押注局实时返还：当前档位倍率 + 距下一档米数；跨档时弹跳 + 横幅
let shownPercent = 0;
function updateReturnHud() {
  const box = $('play-return-box'); if (!box) return;
  box.hidden = !activeRun;
  if (!activeRun) { shownPercent = 0; return; }
  const percent = wagerPercent(engine.distance), next = nextStep(engine.distance);
  if (percent !== shownPercent) {
    const value = $('play-return');
    value.textContent = `×${(percent / 100).toFixed(2)}`;
    if (shownPercent && percent > shownPercent) {
      value.classList.remove('bump'); void value.offsetWidth; value.classList.add('bump');
      if (engine.state !== 'ended') banner(percent >= WAGER.maxPercent ? '✦ 已达最高返还 ✦' : percent >= 100 ? '✦ 保本线达成 ✦' : `返还 ↑ ×${(percent / 100).toFixed(2)}`, true, 900);
      vibrate(12);
    }
    box.classList.toggle('capped', percent >= WAGER.maxPercent);
    shownPercent = percent;
  }
  $('play-return-next').textContent = next ? `再 ${next.meters} m +${(next.gain / 100).toFixed(2)}` : '已封顶 5×';
}
function frame(now) {
  const dt = previous ? Math.min((now - previous) / 1000, .05) : .016; previous = now;
  if (engine) {
    const live = engine.state !== 'ended';
    // 押注局随机带见底：冻结推进（不记帧、不 update），等服务端放出下一段
    const starved = live && activeRun && tape.length - tapeUsed < TAPE_SAFE;
    if (starved !== tapeStalled) { tapeStalled = starved; if (starved) banner('同步航路…', true, 0); else banner('', true, 0); }
    if (starved) requestAdvance();
    else {
      // 逐帧回放日志：记录传给 update 的原始 dt 与本帧输入（结算防作弊的关键）
      if (live && traceFrames.length < TRACE_MAX_FRAMES) traceFrames.push([dt, pendingInputs.splice(0)]);
      else pendingInputs.length = 0;
      try { engine.update(dt); } catch (error) {
        console.error('Run update failed', error);
        engine = null; exitGame(); toast('本局运行异常，已退出，请重新开始');
      }
      if (!engine) { animation = requestAnimationFrame(frame); return; }
      if (activeRun && engine.state !== 'ended' && tape.length - tapeUsed < TAPE_REFILL) requestAdvance();
    }
    updateHud(); art.render(engine, now / 1000);
  }
  animation = requestAnimationFrame(frame);
}

$('continue-adventure').onclick = () => launch((LEVELS.find(level => !profile.bestScore(level.id)) || LEVELS[0]).id);
$('guide-start').onclick = () => launch('level-1');
$('start-daily').onclick = () => {
  const best = profile.bestDaily?.(chinaDay());
  showDialog({ kicker: `DAILY EXPEDITION · ${chinaDay()}`, title: '今天，走一条新路', copy: `同一天的航路固定，可以反复挑战。\n${best ? `今日最佳 ${Math.floor(best.bestDistance)} m` : '新航路已就绪，等你留下第一份成绩。'}`, primary: '开始远征 ↗', action: () => launch('daily'), secondary: '暂不出发', onSecondary: closeDialog });
};
$('open-settings').onclick = () => { location.hash = 'settings'; };
$('pause-game').onclick = pauseGame;
$('dialog-primary').onclick = () => primaryAction?.(); $('dialog-secondary').onclick = () => secondaryAction?.();
$('game-dialog').addEventListener('cancel', event => { event.preventDefault(); if (engine?.state === 'paused') primaryAction?.(); else secondaryAction?.(); });
for (const key of ['sound', 'haptics', 'reducedMotion']) $(`setting-${key}`).onchange = event => { profile.setSetting(key, event.target.checked); applySettings(); if (key === 'sound' && event.target.checked) audio.resume(); };
$('world').addEventListener('pointerdown', event => { if (event.button !== 0) return; swipe = { x: event.clientX, y: event.clientY, id: event.pointerId }; $('world').setPointerCapture(event.pointerId); });
$('world').addEventListener('pointerup', event => {
  if (!swipe || swipe.id !== event.pointerId) return;
  const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy)) return inputMove(Math.sign(dx));
  // 点按：没有明显拖动时，按落点在屏幕左/右半区换道
  if (Math.abs(dx) <= 24 && Math.abs(dy) <= 24) {
    const rect = $('world').getBoundingClientRect();
    inputMove(event.clientX < rect.left + rect.width / 2 ? -1 : 1);
  }
});
$('world').addEventListener('pointercancel', () => { swipe = null; });
window.addEventListener('keydown', event => {
  if (!engine || $('game-dialog').open) return;
  if (['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'KeyP', 'Escape'].includes(event.code)) event.preventDefault();
  if (event.repeat) return;
  if (['ArrowLeft', 'KeyA'].includes(event.code)) inputMove(-1);
  if (['ArrowRight', 'KeyD'].includes(event.code)) inputMove(1);
  if (['KeyP', 'Escape'].includes(event.code)) pauseGame();
});
window.addEventListener('blur', () => { pauseGame(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { pauseGame(); audio.suspend(); } });
window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => { pauseGame(); cancelAnimationFrame(animation); audio.suspend(); clearTimeout(toastTimer); });
window.addEventListener('pageshow', event => { if (event.persisted) { previous = performance.now(); animation = requestAnimationFrame(frame); } });
// —— 网站登录态与钱包余额（只读，不触碰签名/转账）——
const session = new WebsiteSession(state => {
  const wasReady = walletState.status === 'ready';
  walletState = state;
  renderWalletChip();
  if (state.status === 'ready' && !wasReady) recoverPendingSettle();
});
session.start();
renderWalletChip();
$('wallet-chip')?.addEventListener('click', requestLogin);
renderAll(); route(); animation = requestAnimationFrame(frame);
