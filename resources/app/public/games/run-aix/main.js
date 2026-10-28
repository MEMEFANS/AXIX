import { RunnerEngine } from './engine.js?v=20261028c';
import { GameArt } from './art.js?v=20261028c';
import { GameAudio } from './audio.js?v=20261028c';
import { WebsiteSession } from './session.js?v=20261028c';
import { PracticeStore } from './store.js?v=20261028c';
import { SCENES } from './config.js?v=20261028c';
import { loadRules, multiplierForDistance } from './rules.js?v=20261028c';

const $ = id => document.getElementById(id);
const audio = new GameAudio();
let rules = loadRules();
const store = new PracticeStore(undefined, rules);
let modalAction, secondaryAction, bannerTimer, lastAccount, pendingResult, lastSave = 0;
const take = document.createElement('button'); take.className = 'take-button'; take.textContent = '带走试玩积分 ↗'; take.hidden = true;
const pause = document.createElement('button'); pause.className = 'pause-button'; pause.textContent = 'Ⅱ'; pause.setAttribute('aria-label', '暂停游戏'); pause.hidden = true;
document.querySelector('.stage').append(take, pause);

function banner(text, small = false, duration = 0) {
  clearTimeout(bannerTimer); $('banner').textContent = text; $('banner').classList.toggle('small', small);
  if (duration) bannerTimer = setTimeout(() => { $('banner').textContent = ''; }, duration);
}
function showModal({ kicker, title, copy, primary = '好的', action = closeModal, secondary, onSecondary, stats = '' }) {
  $('modal-kicker').textContent = kicker; $('modal-title').textContent = title; $('modal-copy').textContent = copy;
  $('result-stats').innerHTML = stats; // 仅本地固定模板与已格式化的数值，账户字段一律使用 textContent。
  $('modal-primary').textContent = primary; $('modal-secondary').textContent = secondary || '';
  $('modal-secondary').hidden = !secondary; modalAction = action; secondaryAction = onSecondary;
  $('modal').hidden = false; $('modal-primary').focus({ preventScroll: true });
}
function closeModal() {
  if ($('modal').contains(document.activeElement)) document.activeElement.blur();
  $('modal').hidden = true;
}
const number = n => Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
function updateCredits() {
  $('credits').textContent = number(store.data.credits);
  $('consolation').textContent = number(store.data.consolation);
}
function refreshRules() {
  rules = loadRules(); store.setRules(rules);
  $('stake').min = rules.minStake; $('stake').max = rules.maxStake;
  $('stake').value = Math.max(rules.minStake, Math.min(rules.maxStake, Number($('stake').value)));
  $('mode-label').textContent = rules.mode === 'probability' ? '概率模式 · 结果档位由系统抽取' : '操作挑战 · 连点与闪避决定成绩';
  const values = [rules.breakevenDistance, rules.checkpointDistance, rules.maxDistance];
  document.querySelectorAll('.milestones b').forEach((node, index) => { node.firstChild.textContent = values[index]; });
  document.querySelector('.milestones>span:last-child').lastChild.textContent = `极限 ${number(rules.maxMultiplier)}×`;
  for (const button of document.querySelectorAll('[data-stake]')) button.disabled = Number(button.dataset.stake) < rules.minStake || Number(button.dataset.stake) > rules.maxStake;
  stakeChanged();
}
function lobby() {
  pendingResult = null;
  closeModal(); engine.state = 'lobby'; engine.distance = 0; engine.floor = 0; engine.energy = 0; engine.obstacles = [];
  engine.effect = null; engine.weather = null; refreshRules();
  $('lobby').hidden = false; document.querySelector('.cabinet').classList.remove('playing', 'finished');
  take.hidden = pause.hidden = true; banner('');
}
function start() {
  if (!['lobby', 'ended'].includes(engine.state)) return;
  refreshRules(); const stake = Number($('stake').value);
  const status = store.getDailyStatus();
  if (status.cooldownMs > 0 || status.remainingRounds === 0) {
    showModal({ kicker: 'ROUND LIMIT', title: '休息一下再跑', copy: status.cooldownMs > 0 ? `还需等待 ${Math.ceil(status.cooldownMs / 1000)} 秒。` : '已达到本机今日对局上限。', action: lobby }); return;
  }
  if (stake > store.data.credits) {
    showModal({ kicker: 'PRACTICE POINTS', title: '试玩积分不足', copy: `可免费补充至 ${number(rules.initialCredits)} 试玩积分，不涉及 AIX 资产。`, primary: '补充试玩积分', action: () => { store.refill(); updateCredits(); lobby(); }, secondary: '返回', onSecondary: lobby }); return;
  }
  engine.configure(rules);
  if (!engine.start(stake, { protectedRound: store.data.totalRounds < rules.newUserProtectionRounds })) return;
  const opened = store.beginRound(stake, engine.id, engine.snapshot());
  if (!opened.ok) {
    engine.state = 'lobby';
    const pendingRound = opened.error === 'pending-round';
    showModal({ kicker: 'ROUND UNAVAILABLE', title: '暂时不能开跑',
      copy: pendingRound ? '本机已有未完成对局，先恢复或放弃后再开始。' : opened.error || '请检查本机存档后重试。',
      primary: pendingRound ? '恢复未完成对局' : '好的', action: pendingRound ? () => location.reload() : lobby }); return;
  }
  pendingResult = null; closeModal(); document.activeElement?.blur(); $('lobby').hidden = true;
  document.querySelector('.cabinet').classList.add('playing'); document.querySelector('.cabinet').classList.remove('finished');
  updateCredits(); pause.hidden = false; lastSave = 0;
}
function pauseGame() { engine.pause(); }
function saveRound() { if (['running', 'countdown', 'checkpoint', 'paused'].includes(engine.state)) store.checkpointRound(engine.snapshot()); }
function checkpointModal() {
  const r = engine.rules;
  banner(''); showModal({ kicker: 'DOUBLE ACHIEVED', title: '翻倍达成！', copy: `已到达 ${r.checkpointDistance} 米。${r.lockFloorEnabled ? `继续将锁定 ${r.floorMultiplier} 倍保底。` : '本局未开启额外锁底。'}最高 ${r.maxMultiplier} 倍。\n${r.mode === 'probability' ? '概率模式：继续仍按开局抽取的结果区结束。' : '保持连点，继续躲避障碍。'}`,
    primary: `继续冲 ${r.maxMultiplier} 倍 ↗`, action: () => { closeModal(); engine.continue(); saveRound(); },
    secondary: '带走 2 倍试玩积分', onSecondary: () => { closeModal(); engine.take(); } });
}
function presentResult(data) {
  const settled = store.data.records.find(row => row.id === data.id) || data;
  const won = data.payout - data.stake;
  showModal({ kicker: data.reason === 'finish' ? 'COSMIC LEGEND' : 'RUN COMPLETE', title: data.reason === 'finish' ? `极限 ${data.multiplier} 倍达成！` : data.reason === 'take' ? '收益已带走' : '本局冲刺结束',
    copy: data.line || (data.reason === 'take' ? '本局试玩积分已结算，下一站等你挑战。' : '本局冲刺完成。'),
    stats: `<div class="result-grid"><div><b>${data.distance} <small>m</small></b><span>本局距离</span></div><div><b>${number(data.multiplier)}×</b><span>模拟倍率（含门槛）</span></div><div><b>${number(data.payout)}</b><span>带回试玩积分</span></div><div><b>${won >= 0 ? '+' : ''}${number(won)}</b><span>试玩积分变化</span></div></div><p class="fine">本局模拟销毁 ${number(settled.simulatedBurned)} · 累计 ${number(store.data.economy?.burned)}<br>获安慰积分 +${number(settled.consolationAwarded)}（仅用于抽奖）<br>${data.mode === 'probability' ? '概率模式：系统抽取结果档位' : '操作挑战：操作决定成绩'} · 真实 AIX 未变动</p>`,
    primary: `再来一把 · ${number(data.stake)} 积分`, action: start, secondary: '返回大厅', onSecondary: lobby });
}
function settleResult(data) {
  if (store.settle(data)) return true;
  // 另一标签或重复结束事件已结算相同结果时，只恢复展示，不再加分。
  return store.data.records.some(record => record.id === data.id
    && record.stake === data.stake && record.payout === data.payout
    && record.distance === data.distance && record.multiplier === data.multiplier);
}
const engine = new RunnerEngine({ rules, onEvent(name, data) {
  audio.effect(name, data);
  if (name === 'countdown') banner(data || 'GO');
  if (name === 'go') banner('保持连点！', true, 900);
  if (name === 'stumble') banner('停点踉跄 · 继续连点！', true);
  if (name === 'recover') banner('恢复奔跑！', true, 600);
  if (name === 'scheduledWarning') banner('结果区临近 · 概率模式', true, 1100);
  if (name === 'impact') { if (navigator.vibrate) navigator.vibrate([30, 20, 50]); }
  if (name === 'dodge' && engine.energy > 0.8) banner('完美闪避 ✦', true, 500);
  if (name === 'pause') {
    saveRound(); banner(''); audio.suspend();
    showModal({ kicker: 'TAKE A BREATH', title: '休息一下', copy: '对局已暂停。点击继续后再开始跑动。', primary: '继续冲刺', action: () => { closeModal(); engine.resume(); audio.resume(); } });
  }
  if (name === 'checkpoint') { saveRound(); checkpointModal(); }
  if (name === 'end') {
    document.querySelector('.cabinet').classList.add('finished');
    banner(''); take.hidden = pause.hidden = true;
    if (!settleResult(data)) { showModal({ kicker: 'SAVE FAILED', title: '结算尚未保存', copy: '本机存档未能完成结算，保留当前对局后重试。', primary: '重试结算', action: () => { if (settleResult(data)) { updateCredits(); presentResult(data); } }, secondary: '恢复未完成对局', onSecondary: () => location.reload() }); return; }
    updateCredits();
    audio.effect(data.payout >= data.stake ? 'win' : 'lose');
    if (engine.effect && !['take', 'finish'].includes(data.reason)) pendingResult = data;
    else presentResult(data);
  }
} });
const art = new GameArt($('world'));
const session = new WebsiteSession(state => {
  const identity = state.address ? state.address.toLowerCase() : state.status === 'guest' ? '' : lastAccount;
  if (lastAccount !== undefined && identity !== lastAccount) pauseGame();
  lastAccount = identity;
  if (state.status === 'ready') {
    $('account').textContent = `${state.address.slice(0, 6)}…${state.address.slice(-4)}`;
    const [whole, fraction] = state.balance.split('.');
    $('balance').textContent = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction.slice(0, 4) : '');
    $('balance').title = state.balance + ' AIX';
  } else {
    $('balance').textContent = '—'; $('balance').title = '';
    $('account').textContent = { loading: '读取网站账户…', guest: '沿用网站账户 · 当前未登录', unavailable: '账户余额暂不可用' }[state.status];
  }
});
session.start();

$('start').addEventListener('click', start);
$('modal-primary').addEventListener('click', () => modalAction?.());
$('modal-secondary').addEventListener('click', () => secondaryAction?.());
function stakeChanged() {
  $('stake-value').value = $('stake').value;
  document.querySelectorAll('[data-stake]').forEach(b => b.classList.toggle('selected', b.dataset.stake === $('stake').value));
}
$('stake').addEventListener('input', stakeChanged);
document.querySelectorAll('[data-stake]').forEach(b => b.addEventListener('click', () => { $('stake').value = b.dataset.stake; stakeChanged(); }));
for (const [id, fn] of [['left', () => engine.move(-1)], ['right', () => engine.move(1)], ['tap', () => engine.tap()]]) {
  $(id).addEventListener('pointerdown', e => { if (e.button !== 0) return; e.preventDefault(); fn(); });
  // 键盘及辅助技术合成点击没有 pointerdown。
  $(id).addEventListener('click', e => { if (e.detail === 0) fn(); });
}
take.addEventListener('click', () => engine.take()); pause.addEventListener('click', pauseGame);
document.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable) return;
  if (!['running', 'countdown'].includes(engine.state)) return;
  if (['ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  if (e.code === 'ArrowLeft') engine.move(-1);
  if (e.code === 'ArrowRight') engine.move(1);
  if (e.code === 'Space') engine.tap();
  if (e.code === 'KeyP' && ['running', 'countdown'].includes(engine.state)) pauseGame();
});
$('sound').addEventListener('click', async () => {
  const enabled = await audio.toggle(); $('sound').setAttribute('aria-pressed', String(enabled)); $('sound').setAttribute('aria-label', enabled ? '关闭音乐' : '开启音乐');
});
$('rules').addEventListener('click', () => {
  if (['running', 'countdown'].includes(engine.state)) { pauseGame(); return; }
  if (!['lobby', 'ended'].includes(engine.state)) return;
  const ended = engine.state === 'ended';
  const r = engine.state === 'ended' ? engine.rules : loadRules();
  showModal({ kicker: 'HOW TO PLAY', title: '手速点燃星际旅程',
    copy: `${r.mode === 'probability' ? `概率模式：开局按 ${r.lossWeight}/${r.breakEvenWeight}/${r.smallWinWeight}/${r.doubleWeight}/${r.highWinWeight}% 抽取全损/保本/小赚/翻倍/高倍结果区。早撞只减速，断连会踉跄停步，恢复点击后继续；操作不会提高抽取的结果。主动提前带走可能降低最终返还。` : '操作挑战：不抽取结果；致命障碍碰撞立即结束，天气和软障碍会减速。'}\n${r.continuousTapRequired ? `必须保持连点，换道也不能停；开跑/恢复有 ${r.inputGrace} 秒准备，之后停点超过 ${r.tapTimeout} 秒${r.mode === 'skill' ? '即失败' : '会踉跄停步'}。` : '本机配置已关闭断连约束。'}\n左右按钮换道，每秒 ${r.rocketTapRate} 次点击触发火箭加速，最高 ${r.rocketSpeed} M/S，冲刺不无敌。\n${r.breakevenDistance} 米前全损；之后按距离返还，每 ${r.stepDistance} 米 +${r.stepMultiplier} 倍。${r.checkpointDistance} 米可带走 2 倍或继续，${r.maxDistance} 米为 ${r.maxMultiplier} 倍。碰撞后按终止米数返还；倍率包含门槛。\n全损分配：模拟销毁 ${r.burnPercent}%、平台 ${r.platformPercent}%、活动 ${r.activityPercent}%。失败获安慰积分，仅用于本机抽奖。\n本机排行榜只展示，不发奖。所有积分、抽奖和销毁数字均为本地模拟，真实 AIX 仅只读展示。`,
    action: ended ? lobby : closeModal });
  if (r.newUserProtectionRounds > 0 && r.mode === 'probability') $('modal-copy').textContent += `\n本机已开启前 ${r.newUserProtectionRounds} 局保本保护：保护期抽中全损会提升为保本，实际分布与基础比例不同。`;
});
function canOpenPanel() { return ['lobby', 'ended'].includes(engine.state) && !pendingResult; }
function openLottery() {
  if (!canOpenPanel()) return;
  refreshRules();
  const daily = store.getDailyStatus(), drawId = crypto.randomUUID();
  const prizes = store.lotteryPrizes().map(prize => `${prize.name} ${number(prize.probability * 100)}%`).join(' · ');
  const allowed = store.data.consolation >= rules.lotteryCost && daily.remainingDraws !== 0;
  showModal({ kicker: 'CONSOLATION DRAW', title: '安慰积分抽奖',
    copy: `安慰积分 ${number(store.data.consolation)} · 每次消耗 ${rules.lotteryCost}\n${rules.lotteryDailyLimit ? `今日已抽 ${daily.draws} 次 / 上限 ${rules.lotteryDailyLimit}` : '本机配置已关闭今日抽奖'}\n奖品概率：${prizes}\n奖品仅为本机试玩积分或装扮，不兑换真实 AIX。`,
    primary: allowed ? `抽一次 · ${rules.lotteryCost} 安慰积分` : '积分不足或今日次数已满',
    action: allowed ? () => {
      const result = store.draw(drawId);
      updateCredits();
      showModal({ kicker: 'DRAW RESULT', title: result.ok ? result.draw.prize.name : '暂时不能抽奖',
        copy: result.ok ? (store.storageAvailable ? '抽奖结果已保存在本机，安慰积分仅扣除一次。' : '本次页面内已结算，安慰积分仅扣除一次。浏览器存档不可用，刷新后可能丢失。') : result.error,
        primary: '返回抽奖', action: openLottery, secondary: '返回大厅', onSecondary: lobby });
    } : lobby, secondary: '返回大厅', onSecondary: lobby });
}
$('lottery').addEventListener('click', openLottery);
function showLeaderboard(period = 'daily') {
  if (!canOpenPanel()) return;
  showModal({ kicker: 'LOCAL LEADERBOARD', title: period === 'daily' ? '今日本机榜' : '本机总榜',
    copy: '仅收录当前浏览器完成的对局，不含虚构玩家。北京时间日界；榜单纯展示，不发奖。',
    primary: period === 'daily' ? '查看总榜' : '查看今日榜', action: () => showLeaderboard(period === 'daily' ? 'all' : 'daily'),
    secondary: '返回大厅', onSecondary: lobby });
  const list = document.createElement('div'); list.className = 'record-list';
  store.getLeaderboard(period).forEach((record, index) => {
    const row = document.createElement('div'); row.className = 'record-row';
    for (const value of [`#${index + 1} 本机玩家`, `${number(record.distance)} m`, `${number(record.multiplier)}×`]) {
      const item = document.createElement('span'); item.textContent = value; row.append(item);
    }
    list.append(row);
  });
  if (!list.childElementCount) list.textContent = '完成第一局，即可留下你的成绩。';
  $('result-stats').replaceChildren(list);
}
$('leaderboard').addEventListener('click', () => showLeaderboard());
$('records').addEventListener('click', () => {
  if (!['lobby', 'ended'].includes(engine.state)) return;
  showModal({ kicker: 'YOUR LOCAL RUNS', title: '每一步都算数', copy: '仅当前浏览器最近 20 局试玩纪录，无奖励。', action: engine.state === 'ended' ? lobby : closeModal });
  const list = document.createElement('div'); list.className = 'record-list';
  for (const record of store.data.records) {
    const row = document.createElement('div'); row.className = 'record-row';
    for (const text of [new Date(record.date).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), `${Number(record.distance) || 0} m`, `${(Number(record.multiplier) || 0).toFixed(1)}×`]) { const el = document.createElement('span'); el.textContent = text; row.append(el); }
    list.append(row);
  }
  if (!list.children.length) list.textContent = '还没有纪录，来开启第一趟旅程。';
  $('result-stats').replaceChildren(list);
});
$('back').addEventListener('click', e => {
  if (window.parent !== window) { e.preventDefault(); window.parent.postMessage({ type: 'run-aix:close' }, location.origin); }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { pauseGame(); audio.suspend(); }
  else if (engine.state !== 'paused') audio.resume();
});
let previous = performance.now(), animation;
function frame(now) {
  engine.update((now - previous) / 1000); previous = now;
  art.render(engine, now / 1000);
  $('distance').textContent = Math.floor(engine.distance);
  $('multiplier').textContent = Math.max(engine.floor || 0, multiplierForDistance(engine.distance, engine.rules)).toLocaleString('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 6 }) + '×';
  const sceneIndex = Math.min(2, Math.floor(engine.distance / (engine.rules.maxDistance / 3)));
  $('scene').textContent = `0${sceneIndex + 1} / ${SCENES[sceneIndex].name}`;
  $('energy-fill').style.width = `${engine.energy * 100}%`;
  $('energy-label').textContent = engine.stumbled ? '断连踉跄 · 点击恢复' : engine.rocketActive ? 'ROCKET MODE · 火箭冲刺' : `保持连点 · ${engine.rules.rocketTapRate} 次/秒冲刺`;
  $('speed').textContent = engine.state === 'running' ? `${engine.speed.toFixed(0)} M/S` : 'READY TO RUN';
  take.hidden = engine.state !== 'running' || engine.distance < engine.rules.breakevenDistance;
  $('tap').disabled = $('left').disabled = $('right').disabled = engine.state !== 'running';
  for (const id of ['lottery', 'leaderboard', 'records', 'rules']) $(id).disabled = !['lobby', 'ended'].includes(engine.state) || !!pendingResult;
  if (pendingResult && (!engine.effect || engine.effect.elapsed >= engine.effect.duration)) {
    const result = pendingResult; pendingResult = null; presentResult(result);
  }
  if (now - lastSave > 750) { saveRound(); lastSave = now; }
  animation = requestAnimationFrame(frame);
}
refreshRules(); updateCredits();
const unfinished = store.recoverPending();
if (unfinished) {
  if (unfinished.snapshot && unfinished.id === unfinished.snapshot.id && unfinished.stake === unfinished.snapshot.stake && engine.restore(unfinished.snapshot)) {
    rules = engine.rules; store.setRules(rules); $('lobby').hidden = true; document.querySelector('.cabinet').classList.add('playing');
    if (engine.state === 'checkpoint') checkpointModal();
    else showModal({ kicker: 'ROUND RECOVERY', title: '继续上次冲刺', copy: '已恢复本机未完成对局，门槛不会重复扣除。当前规则和结果区也保持原样。',
      primary: '继续冲刺', action: () => { closeModal(); engine.resume(); audio.resume(); },
      secondary: '放弃本局（门槛不返还）', onSecondary: () => { store.abortPending(); updateCredits(); lobby(); } });
  } else showModal({ kicker: 'ROUND RECOVERY', title: '发现未完成对局', copy: '存档无法恢复；结束本局会保留已消耗的模拟门槛，不额外扣分、不送安慰积分。',
    primary: '结束未完成对局', action: () => { store.abortPending(); updateCredits(); lobby(); } });
}
animation = requestAnimationFrame(frame);
window.addEventListener('pagehide', event => {
  pauseGame(); saveRound(); session.stop(); cancelAnimationFrame(animation); clearTimeout(bannerTimer);
  if (event.persisted) audio.suspend();
  else { audio.destroy(); art.destroy(); }
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  session.start(); previous = performance.now(); animation = requestAnimationFrame(frame);
  if (engine.state !== 'paused') audio.resume();
});
