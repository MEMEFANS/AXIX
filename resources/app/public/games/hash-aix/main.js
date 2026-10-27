import { CHOICES, RULES, verifyServerRecord } from './core.js';
import { WebsiteSession } from '../run-aix/session.js';
import { ServerSession } from './server-session.js';

const $ = id => document.getElementById(id);
const game = new ServerSession();
const choiceMap = new Map(CHOICES.map(choice => [choice.id, choice]));
const settingsKey = 'hash-aix:settings:v2';
const phaseLabels = { open: '等待你的选择', locked: '正在揭晓', revealed: '本局已完成', idle: '准备中' };
let settings = { sound: false, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, clientSeed: 'AIX-starlight' };
try { const saved = JSON.parse(localStorage.getItem(settingsKey) || 'null'); if (saved && typeof saved === 'object') { settings.sound = Boolean(saved.sound); settings.reducedMotion = Boolean(saved.reducedMotion); if (typeof saved.clientSeed === 'string') settings.clientSeed = saved.clientSeed; } } catch { /* 记忆型设置保留默认值 */ }
let selected = null, view = 'game', filter = 'all', ready = false, busy = false;
let verifyId = null, verifyToken = 0, toastTimer, revealTimer, uiTimer;
let rolling = false, rollFrame = 0; // 开奖滚字动画状态
let walletState = { status: 'guest' }, audioContext;
const fmt = value => Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = value => `${Number(value) > 0 ? '+' : ''}${fmt(value)}`;
const short = (text, first = 10, last = 8) => text ? `${text.slice(0, first)}…${text.slice(-last)}` : '—';
const roundLabel = record => `#${String(record.nonce).padStart(6, '0')}`;
const dateLabel = timestamp => new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const outcomeLabel = record => `${record.digit % 2 ? '单' : '双'} · ${record.digit >= 8 ? '大' : '小'}`;
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function toast(text) { clearTimeout(toastTimer); $('toast').textContent = text; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200); }
function setMessage(text = '') { $('form-message').textContent = text; }
function saveSettings() { try { localStorage.setItem(settingsKey, JSON.stringify(settings)); } catch { /* 设置不属于账本 */ } }
function applySettings() {
  document.body.classList.toggle('reduced-motion', settings.reducedMotion);
  $('reduced-motion').checked = settings.reducedMotion;
  $('sound-toggle').setAttribute('aria-pressed', String(settings.sound));
  $('sound-toggle').setAttribute('aria-label', settings.sound ? '关闭音效' : '开启音效');
  $('sound-toggle').querySelector('i').hidden = settings.sound;
  if (document.activeElement !== $('client-seed')) $('client-seed').value = settings.clientSeed;
}
async function sound(type) {
  if (!settings.sound || document.hidden) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume(); if (!settings.sound) return;
    const notes = type === 'win' ? [523, 659, 784, 1047] : type === 'reveal' ? [330, 440, 660] : type === 'lock' ? [360] : [520, 780];
    notes.forEach((note, i) => {
      const oscillator = audioContext.createOscillator(), gain = audioContext.createGain(), time = audioContext.currentTime + i * .085;
      oscillator.type = 'sine'; oscillator.frequency.value = note;
      gain.gain.setValueAtTime(.0001, time); gain.gain.exponentialRampToValueAtTime(.045, time + .012); gain.gain.exponentialRampToValueAtTime(.0001, time + .25);
      oscillator.connect(gain); gain.connect(audioContext.destination); oscillator.start(time); oscillator.stop(time + .28);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    });
  } catch { settings.sound = false; applySettings(); saveSettings(); }
}
// —— 钱包登录态（与跑酷同一套只读会话）——
function renderWallet() {
  const status = walletState.status, login = $('wallet-login');
  $('balance').textContent = status === 'ready' ? fmt(game.state?.balanceA) : '—';
  login.hidden = status !== 'guest';
  if (status === 'ready') login.hidden = true;
}
function requestLogin() {
  try {
    if (window.parent !== window) { window.parent.postMessage({ type: 'aix-games:login' }, location.origin); toast('请在打开的登录面板完成钱包登录'); return; }
  } catch { /* 独立窗口回退站内首页 */ }
  location.href = '/';
}
function renderNotice() {
  let text = '';
  if (walletState.status === 'unavailable') text = '平台服务未连接，AIX 押注暂不可用。请通过平台内的游戏入口打开本页。';
  else if (walletState.status === 'guest') text = '请先登录钱包，再开始 AIX 押注。';
  else if (walletState.status === 'ready' && game.unavailable) text = '平台接口暂时不可用，请稍后刷新重试。';
  $('storage-notice').hidden = !text; $('storage-notice').textContent = text;
}
function renderHex() {
  $('hex-ribbon').replaceChildren(...Array.from({ length: 16 }, (_, digit) => {
    const node = el('span', '', digit.toString(16).toUpperCase()); node.dataset.digit = digit.toString(16); return node;
  }));
  $('rule-digits').replaceChildren(...Array.from({ length: 16 }, (_, digit) => el('span', digit % 2 ? '' : 'even', digit.toString(16).toUpperCase())));
}
function validStake() {
  const text = String($('stake').value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return false;
  const value = Number(text);
  return Number.isFinite(value) && value >= Number(game.state?.minStakeA || .1) && value <= Number(game.state?.maxStakeA || 10000);
}
function renderControls() {
  const phase = game.phase, record = game.current, balance = Number(game.state?.balanceA || 0);
  const editable = ready && !busy && phase === 'open' && walletState.status === 'ready';
  for (const button of document.querySelectorAll('[data-choice]')) {
    const choice = choiceMap.get(button.dataset.choice); button.setAttribute('aria-label', `${choice.label}：${choice.description}`);
    const chosen = button.dataset.choice === (record?.choice || selected); button.classList.toggle('selected', chosen); button.setAttribute('aria-pressed', String(chosen)); button.disabled = !editable;
  }
  for (const input of [$('stake'), $('stake-minus'), $('stake-plus'), ...document.querySelectorAll('[data-stake]')]) input.disabled = !editable;
  const stake = Number($('stake').value), valid = validStake();
  for (const button of document.querySelectorAll('[data-stake]')) button.classList.toggle('selected', Number(button.dataset.stake) === stake);
  $('return-preview').textContent = valid ? fmt(stake * 1.98) : '—';
  $('confirm').disabled = !editable || !selected || !valid || balance < stake;
  $('confirm').hidden = phase === 'locked' || phase === 'revealed'; $('next-round').hidden = phase !== 'revealed';
  $('next-round').disabled = busy || !ready;
  $('confirm-label').textContent = busy ? '正在结算…' : !ready ? '连接平台中…' : phase === 'locked' ? '正在揭晓…' : !selected ? '请选择预测' : !valid ? '押注需 0.1 – 10000 AIX' : balance < stake ? 'AIX 余额不足' : `确认${choiceMap.get(selected).label} · ${fmt(stake)} AIX`;
  $('entry-controls').hidden = phase === 'locked' || phase === 'revealed'; $('round-summary').hidden = phase !== 'revealed';
  $('ticket').hidden = !record || phase !== 'locked';
  if (record && phase === 'locked') {
    $('ticket-detail').textContent = `${choiceMap.get(record.choice).label} · ${fmt(record.stakeA)} AIX`;
    $('ticket-status').textContent = '押注已扣除，等待哈希揭晓。';
  }
  const digits = new Set(choiceMap.get(record?.choice || selected)?.digits || []);
  $('board-hint').textContent = phase === 'revealed' ? `本局末位 ${record.hexDigit.toUpperCase()} · ${outcomeLabel(record)}` : phase === 'locked' ? '种子已锁定，正在展开这一局的答案' : selected ? `已选「${choiceMap.get(selected).label}」· 亮起的 8 个数字均可命中` : '选一边，看看哪些数字属于你';
  for (const node of $('hex-ribbon').children) {
    node.classList.toggle('chosen', phase !== 'revealed' && digits.has(node.dataset.digit));
    node.classList.toggle('result', phase === 'revealed' && node.dataset.digit === record?.hexDigit);
    node.classList.toggle('scanning', phase === 'locked' && !settings.reducedMotion && Number.parseInt(node.dataset.digit, 16) === Math.floor(performance.now() / 95) % 16);
  }
}
function renderPhase() {
  if (!ready) return;
  const phase = game.phase, record = game.current;
  $('round-id').textContent = record ? roundLabel(record) : `#${String(game.nextNonce).padStart(6, '0')}`;
  $('phase-pill').textContent = phaseLabels[phase] || '准备中';
  $('page-game').classList.toggle('round-complete', phase === 'revealed');
  $('core-stage').classList.toggle('locked', phase === 'locked'); $('core-stage').classList.toggle('revealed', phase === 'revealed');
  $('mode-label').textContent = 'AIX / PROVABLY FAIR';
  $('countdown-label').textContent = phase === 'open' ? '你的节奏' : phase === 'locked' ? '距离揭晓' : '本局完成';
  $('countdown').textContent = phase === 'revealed' ? 'DONE' : phase === 'locked' ? `${(game.countdownMs / 1000).toFixed(1)}s` : 'READY';
  $('core-caption').textContent = phase === 'open' ? '押上 AIX，选一边' : phase === 'locked' ? '答案正在展开' : '本局哈希末位';
  // 揭晓前的滚动数字由 rollDigits() 逐帧驱动，这里不覆盖
  if (!(phase === 'locked' && rolling)) $('core-digit').textContent = phase === 'revealed' ? record.hexDigit.toUpperCase() : phase === 'locked' ? '··' : '?';
  $('core-classification').textContent = phase === 'revealed' ? `${outcomeLabel(record)} · 十进制 ${record.digit}` : phase === 'locked' ? 'SHA–256 / 计算中' : '十六种可能，一个答案';
  const index = ['open', 'locked', 'revealed'].indexOf(phase);
  for (const [i, id] of ['step-open', 'step-lock', 'step-reveal'].entries()) { $(id).classList.toggle('active', index === i); $(id).classList.toggle('complete', index > i); }
  $('round-progress').style.width = `${phase === 'revealed' ? 100 : phase === 'locked' ? Math.min(100, Math.max(0, (1 - game.countdownMs / RULES.quickRevealMs) * 100)) : 0}%`;
  $('commitment-short').textContent = short(game.nextCommitment, 10, 7);
  $('full-commitment').textContent = game.nextCommitment || '—';
  $('commitment-context').textContent = `${record?.clientSeed ?? settings.clientSeed} / ${record?.nonce ?? game.nextNonce}`;
  $('result-callout').hidden = phase !== 'revealed';
  if (phase === 'revealed' && record) {
    $('round-summary').classList.toggle('miss', record.won === false);
    $('summary-title').textContent = record.won ? '这一局，命中了。' : '本局未命中';
    $('summary-digit').textContent = record.hexDigit.toUpperCase(); $('summary-kind').textContent = `${outcomeLabel(record)} · 数值 ${record.digit}`;
    $('summary-choice').textContent = choiceMap.get(record.choice)?.label || '—';
    $('summary-stake').textContent = `${fmt(record.stakeA)} AIX`;
    $('summary-return').textContent = `${fmt(record.payoutA)} AIX`;
    $('summary-net').textContent = signed(record.netA);
    $('result-callout').classList.toggle('miss', record.won === false);
    $('result-symbol').textContent = record.won ? '✦' : '◇';
    $('result-title').textContent = record.won ? `命中！返还 ${fmt(record.payoutA)} AIX` : '本局未命中';
    $('result-copy').textContent = `你选择「${choiceMap.get(record.choice)?.label}」· AIX 变化 ${signed(record.netA)}`;
  }
  renderControls();
}
function recordBall(record) { return el('span', `digit-ball${record.digit % 2 === 0 ? ' even' : ''}`, record.hexDigit.toUpperCase()); }
function inspectRecord(id) { verifyId = id; location.hash = 'verify'; renderVerification(); }
function renderRecent(records) {
  $('recent-digits').replaceChildren(...records.slice(0, 16).map(record => {
    const button = el('button', 'recent-item'); button.type = 'button'; button.setAttribute('aria-label', `${roundLabel(record)}，结果${record.hexDigit.toUpperCase()}，查看核验`);
    button.append(recordBall(record), el('small', '', String(record.nonce).padStart(3, '0'))); button.onclick = () => inspectRecord(record.id); return button;
  }));
  if (!records.length) $('recent-digits').append(el('p', 'empty-text', '还没有结果，第一局等你开始。'));
}
function renderHistory() {
  const records = game.history;
  const participated = records.filter(record => record.choice);
  $('stat-played').textContent = game.stats.bets || participated.length; $('stat-wins').textContent = game.stats.wins || 0;
  $('stat-staked').textContent = fmt(game.stats.stakedA);
  $('stat-net').textContent = signed(game.stats.netA);
  const shown = records.filter(record => filter === 'all' || (filter === 'played' ? Boolean(record.choice) : record.won));
  $('history-empty').hidden = shown.length > 0;
  $('history-empty').querySelector('h3').textContent = records.length ? '这个筛选下还没有记录' : '星图还是空白的';
  $('history-list').replaceChildren(...shown.map(record => {
    const row = el('div', 'history-row');
    const round = el('div', 'history-round'); round.append(el('b', '', roundLabel(record)), el('small', '', dateLabel(record.createdAt)));
    const outcome = el('div', 'history-outcome'); outcome.append(recordBall(record), el('small', '', outcomeLabel(record)));
    const choice = el('div', 'history-choice', `选择 ${choiceMap.get(record.choice)?.label || '—'}`); choice.append(el('small', '', `${fmt(record.stakeA)} AIX`));
    const net = Number(record.netA);
    const result = el('div', `history-result${net < 0 ? ' negative' : ''}`, signed(net));
    result.append(el('small', '', record.won ? '命中 · AIX 变化' : '未命中 · AIX 变化'));
    const hash = el('code', 'history-hash', short(record.hash, 6, 4)); hash.title = record.hash;
    const check = el('button', 'history-check', '↗'); check.type = 'button'; check.setAttribute('aria-label', `核验${roundLabel(record)}`); check.onclick = () => inspectRecord(record.id);
    row.append(round, outcome, choice, result, hash, check); return row;
  }));
  $('export-records').disabled = !records.length;
}
function selectedRecord() { return game.history.find(record => record.id === verifyId) || null; }
function proofField(label, value, emphasis = false) { const field = el('div', 'proof-field'); field.append(el('label', '', label), el(emphasis ? 'strong' : 'code', '', String(value))); return field; }
function renderVerification() {
  const records = game.history;
  if (!records.some(record => record.id === verifyId)) verifyId = records[0]?.id || null;
  $('verify-round').replaceChildren(...records.map(record => { const option = el('option', '', `${roundLabel(record)} · ${record.hexDigit.toUpperCase()} · ${dateLabel(record.createdAt)}`); option.value = record.id; return option; }));
  if (!records.length) { const option = el('option', '', '暂无已揭晓记录'); option.value = ''; $('verify-round').append(option); }
  $('verify-round').value = verifyId || ''; $('verify-round').disabled = !records.length;
  const record = selectedRecord(); $('verify-button').disabled = $('copy-proof').disabled = !record;
  $('verification-result').hidden = true; verifyToken++;
  $('proof-fields').replaceChildren(...(record ? [
    proofField('回合 / 判定结果', `${roundLabel(record)} · ${record.hexDigit.toUpperCase()}（${record.digit}）· ${outcomeLabel(record)}`, true),
    proofField('公开承诺 · SHA256(serverSeed)', record.serverSeedHash), proofField('已揭晓服务端种子 · serverSeed', record.serverSeed),
    proofField('玩家种子 · clientSeed', record.clientSeed), proofField('回合序号 · nonce', record.nonce),
    proofField('最终 SHA-256', record.hash), proofField('预测与返还', `${choiceMap.get(record.choice)?.label || '—'} · 押注 ${fmt(record.stakeA)} · 返还 ${fmt(record.payoutA)} AIX`),
  ] : [el('p', 'empty-text', '完成一局后，完整凭证会显示在这里。')]));
}
async function runVerification(record) {
  const token = ++verifyToken; $('verification-result').hidden = false; $('verification-result').classList.remove('failed'); $('verification-result').textContent = '正在复算 SHA-256…';
  try {
    const result = await verifyServerRecord(record); if (token !== verifyToken) return;
    $('verification-result').classList.toggle('failed', !result.ok);
    $('verification-result').textContent = result.ok ? '✓ 承诺一致   ✓ 哈希一致\n✓ 末位判定一致   ✓ 1.98× 返还一致\n服务端凭证复核通过。' : `核验未通过。\n${result.error === 'invalid-record' ? '凭证格式不完整或不符合服务端回合格式。' : [['承诺', result.commitOk], ['哈希', result.hashOk], ['结果', result.resultOk], ['返还', result.payoutOk]].filter(([, ok]) => !ok).map(([label]) => `${label}不一致`).join('、')}`;
  } catch { if (token === verifyToken) { $('verification-result').classList.add('failed'); $('verification-result').textContent = '浏览器暂时无法计算哈希，请稍后重试。'; } }
}
function renderData() {
  renderWallet(); renderNotice(); renderRecent(game.history); renderHistory();
  if (view === 'verify') renderVerification();
}
function route(event) {
  const next = location.hash.slice(1); view = ['game', 'history', 'verify', 'rules'].includes(next) ? next : 'game';
  for (const page of document.querySelectorAll('.page')) page.hidden = page.id !== `page-${view}`;
  for (const link of document.querySelectorAll('.side-nav a,.mobile-nav a')) { const active = link.hash === `#${view}`; link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); }
  $('breadcrumb-current').textContent = { game: '哈希星盘', history: '我的记录', verify: '结果核验', rules: '玩法指南' }[view];
  if (view === 'verify') renderVerification();
  if (view === 'history') renderHistory();
  if (event?.type === 'hashchange') $('main').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'instant' });
}
async function action(operation, success) {
  if (busy || !ready) return;
  busy = true; setMessage(''); renderControls();
  try { const result = await operation(); if (result.ok) success?.(result); else setMessage(result.message || '操作未完成，请稍后重试。'); }
  catch { setMessage('操作未完成，请稍后重试。'); }
  finally { busy = false; renderData(); renderPhase(); }
}
// —— 开奖演出：老虎机式滚字（先快后慢）→ 揭晓爆发 / 落空震动 + 浮动盈亏 + 连中徽章 ——
const HEX = '0123456789ABCDEF';
function rollDigits() {
  cancelAnimationFrame(rollFrame); rolling = false;
  if (settings.reducedMotion || game.phase !== 'locked') return;
  rolling = true;
  const total = Math.max(1, game.countdownMs || RULES.quickRevealMs);
  let last = 0, previous = '';
  const step = now => {
    if (game.phase !== 'locked') { rolling = false; return; }
    const progress = 1 - game.countdownMs / total;
    if (now - last > 45 + progress * progress * 240) {
      last = now;
      let next; do next = HEX[Math.floor(Math.random() * 16)]; while (next === previous);
      previous = next; $('core-digit').textContent = next;
      $('core-digit').classList.remove('tick'); void $('core-digit').offsetWidth; $('core-digit').classList.add('tick');
    }
    rollFrame = requestAnimationFrame(step);
  };
  rollFrame = requestAnimationFrame(step);
}
function winStreak(record) {
  const list = [record, ...game.history.filter(item => item.id !== record.id)];
  let streak = 0; for (const item of list) { if (!item.won) break; streak += 1; }
  return streak;
}
function celebrate(record) {
  if (!record) return;
  const stage = $('core-stage');
  const streak = record.won ? winStreak(record) : 0;
  if (streak >= 2) $('result-title').textContent += ` · 连中 ${streak} 局`;
  if (settings.reducedMotion) return;
  stage.classList.remove('burst-win', 'burst-lose'); void stage.offsetWidth;
  stage.classList.add(record.won ? 'burst-win' : 'burst-lose');
  const gain = el('span', `float-gain ${record.won ? 'up' : 'down'}`, record.won ? `+${fmt(record.netA)} AIX` : `−${fmt(record.stakeA)} AIX`);
  stage.append(gain); setTimeout(() => gain.remove(), 1600);
  if (record.won) {
    for (let i = 0; i < 18; i += 1) {
      const spark = el('i', 'win-spark'); const angle = (i / 18) * Math.PI * 2 + Math.random() * .3, dist = 70 + Math.random() * 70;
      spark.style.setProperty('--dx', `${Math.cos(angle) * dist}px`); spark.style.setProperty('--dy', `${Math.sin(angle) * dist * .7}px`);
      stage.append(spark); setTimeout(() => spark.remove(), 900);
    }
    if (streak >= 2) { const badge = el('span', 'streak-badge', `连中 ×${streak}`); stage.append(badge); setTimeout(() => badge.remove(), 2200); }
  }
  setTimeout(() => stage.classList.remove('burst-win', 'burst-lose'), 1200);
}
function scheduleReveal() {
  clearTimeout(revealTimer);
  rollDigits();
  revealTimer = setTimeout(async () => {
    cancelAnimationFrame(rollFrame); rolling = false;
    renderPhase(); sound(game.current?.won ? 'win' : 'reveal');
    const record = game.current;
    await game.refreshStats(); renderData(); renderPhase();
    celebrate(record);
  }, Math.max(50, game.countdownMs || RULES.quickRevealMs));
}
function download(name, content) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = el('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

for (const button of document.querySelectorAll('[data-choice]')) button.onclick = () => { if (game.phase !== 'open' || busy) return; selected = button.dataset.choice; setMessage(); renderControls(); sound('select'); };
for (const button of document.querySelectorAll('[data-stake]')) button.onclick = () => { $('stake').value = button.dataset.stake; setMessage(); renderControls(); };
$('stake').addEventListener('input', () => { setMessage(validStake() ? '' : '押注金额需为 0.1 – 10000 之间、最多两位小数。'); renderControls(); });
for (const [id, delta] of [['stake-minus', -1], ['stake-plus', 1]]) $(id).onclick = () => { const value = Number($('stake').value) || 1; $('stake').value = Math.max(.1, Math.min(10000, value + delta)).toFixed(2).replace(/\.?0+$/, ''); setMessage(); renderControls(); };
$('confirm').onclick = () => action(async () => {
  const result = await game.wager(selected, String($('stake').value).trim(), settings.clientSeed);
  if (result.ok) scheduleReveal();
  return result;
}, () => { sound('lock'); toast('押注已确认，星盘揭晓中。'); });
$('next-round').onclick = () => { if (busy) return; game.beginRound(); selected = null; setMessage(); renderData(); renderPhase(); };
$('result-verify').onclick = () => { const record = game.current; if (record) inspectRecord(record.id); };
$('summary-verify').onclick = $('result-verify').onclick;
$('inspect-commitment').onclick = () => { if (game.nextCommitment) $('commitment-dialog').showModal(); };
$('close-commitment').onclick = () => $('commitment-dialog').close();
for (const button of document.querySelectorAll('[data-filter]')) button.onclick = () => { filter = button.dataset.filter; for (const item of document.querySelectorAll('[data-filter]')) item.classList.toggle('active', item === button); renderHistory(); };
$('verify-round').onchange = () => { verifyId = $('verify-round').value; renderVerification(); };
$('verify-button').onclick = () => { const record = selectedRecord(); if (record) runVerification(record); };
$('verify-pasted').onclick = () => { try { const text = $('proof-json').value; if (text.length > 30000) throw new Error('too-large'); runVerification(JSON.parse(text)); } catch { $('verification-result').hidden = false; $('verification-result').classList.add('failed'); $('verification-result').textContent = '请粘贴一份完整的回合 JSON 凭证（最多 30,000 字符）。'; } };
$('copy-proof').onclick = async () => {
  const record = selectedRecord(); if (!record) return;
  const text = JSON.stringify(record, null, 2);
  try { await navigator.clipboard.writeText(text); toast('本局核验凭证已复制。'); }
  catch { $('proof-json').value = text; document.querySelector('.manual-proof').open = true; $('proof-json').focus(); $('proof-json').select(); toast('已展开凭证，可以直接复制。'); }
};
$('export-records').onclick = () => download('aix-hash-records.json', JSON.stringify({ kind: 'aix-hash-server-proof', exportedAt: new Date().toISOString(), records: game.history }, null, 2));
$('seed-form').onsubmit = event => {
  event.preventDefault();
  const value = $('client-seed').value.trim();
  if (!/^[A-Za-z0-9_.\-]{1,64}$/.test(value)) { $('seed-message').textContent = '玩家种子需为 1–64 位字母、数字、短横线、下划线或小数点。'; return; }
  settings.clientSeed = value; saveSettings();
  $('seed-message').textContent = '玩家种子已保存，下一局生效。'; toast('玩家种子已保存，下一局生效。');
};
$('wallet-login').onclick = requestLogin;
$('sound-toggle').onclick = () => { settings.sound = !settings.sound; saveSettings(); applySettings(); if (settings.sound) sound('select'); else audioContext?.suspend(); };
$('reduced-motion').onchange = event => { settings.reducedMotion = event.target.checked; saveSettings(); applySettings(); };
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (document.hidden) audioContext?.suspend(); });
window.addEventListener('pagehide', () => { clearInterval(uiTimer); clearTimeout(revealTimer); clearTimeout(toastTimer); audioContext?.suspend(); });
window.addEventListener('pageshow', event => { if (event.persisted) startTimers(); });
function startTimers() { clearInterval(uiTimer); uiTimer = setInterval(() => { if (!document.hidden && game.phase === 'locked') renderPhase(); }, 150); }

const walletSession = new WebsiteSession(async state => {
  const wasReady = walletState.status === 'ready';
  walletState = state;
  if (state.status === 'ready' && !wasReady) await boot();
  renderData(); renderPhase();
});
walletSession.start();

async function boot() {
  const result = await game.load();
  if (!result.ok) { ready = false; renderData(); renderPhase(); return; }
  ready = true;
  renderData(true); renderPhase(); startTimers();
}
renderHex(); applySettings(); route(); renderData(); renderPhase();
boot();
