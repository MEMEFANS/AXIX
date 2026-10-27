import { DEFAULT_RULES, RULE_LIMITS, normalizeRules, loadRules, loadRulesHistory, saveRules, resetRules, rollbackRules, simulateRules } from './rules.js';
import { loadCatalog, validateCatalog, loadCatalogHistory, saveCatalog, resetCatalog, rollbackCatalog, CATALOG_STORAGE_KEY } from './catalog.js';
import { HAZARDS } from './hazards.js';

const $ = selector => document.querySelector(selector);
const form = $('#rules-form');
const groups = [
  { title: '参与与玩法', intro: '试玩积分与网站 AIX 余额独立；概率模式向玩家公开系统抽档。', fields: [
    ['mode', '玩法模式', 'select'], ['minStake', '最低门槛'], ['maxStake', '最高门槛'], ['initialCredits', '新存档初始积分', '', '只影响新建试玩存档。'],
    ['newUserProtectionRounds', '新手保护局数', '', '0 为关闭；概率模式前 N 局结果档至少保本。'], ['roundCooldown', '开局冷静期（秒）', '', '0 为关闭。'], ['dailyRoundLimit', '每日局数上限', '', '0 为不限。'],
  ] },
  { title: '距离与收益', intro: '从保本线的 1.0 倍起，每步增加收益。翻倍线须恰为 2 倍，最远距离须恰好达到最高倍率。默认 100 米保本、200 米翻倍、500 米 5 倍。', fields: [
    ['breakevenDistance', '保本线（米）'], ['checkpointDistance', '翻倍线（米）'], ['maxDistance', '最远距离（米）'], ['stepDistance', '每步距离（米）'], ['stepMultiplier', '每步增加倍率'], ['maxMultiplier', '最高倍率'], ['lockFloorEnabled', '翻倍后锁定保底', 'checkbox'], ['floorMultiplier', '锁定保底倍率'],
  ] },
  { title: '系统结果分布', intro: '五档合计必须为 100%。小赚按收益步长在 1–2 倍之间均匀抽取，高倍在 2 倍以上至封顶均匀抽取。', fields: [
    ['lossWeight', '全损概率（%）'], ['breakEvenWeight', '保本概率（%）'], ['smallWinWeight', '小赚概率（%）'], ['doubleWeight', '翻倍概率（%）'], ['highWinWeight', '高倍概率（%）'],
  ] },
  { title: '连点与速度', intro: '连点约束默认开启。宽限后停点超过 0.2 秒，概率模式踉跄减速，纯操作模式失败；暂停、失焦由游戏暂停计时。', fields: [
    ['continuousTapRequired', '开启手不能停', 'checkbox'], ['tapTimeout', '停点容差（秒）'], ['inputGrace', '开跑宽限（秒）'], ['baseSpeed', '正常速度（米/秒）'], ['maxSpeed', '连点最高速度'], ['rocketSpeed', '火箭速度'], ['rocketTapRate', '火箭所需手速（次/秒）'],
  ] },
  { title: '障碍节奏', intro: '预警须保留至少 0.55 秒的火箭速度反应时间，末期行距更小、双障碍与换道更密集。概率填写 0–1，例如 0.5 表示 50%。', fields: [
    ['warningDistance', '障碍预警距离（米）'], ['firstSpawnDistance', '首排出现距离（米）'], ['rowSpacingStart', '前期障碍行距（米）'], ['rowSpacingEnd', '后期障碍行距（米）'], ['doubleChanceStart', '前期双障碍概率'], ['doubleChanceEnd', '后期双障碍概率'], ['changeChanceStart', '前期强制换道概率'], ['changeChanceEnd', '后期强制换道概率'],
  ] },
  { title: '模拟分配与安慰抽奖', intro: '全损门槛的模拟分配合计必须为 100%。安慰积分只能参与本机抽奖，不可交易、转让或兑换真实币。', fields: [
    ['burnPercent', '模拟销毁占比（%）'], ['platformPercent', '模拟平台占比（%）'], ['activityPercent', '模拟活动占比（%）'], ['consolationPerPoint', '每损失 1 分赠安慰积分'], ['consolationDailyCap', '安慰积分每日赠送上限', '', '0 为不赠送。'], ['lotteryCost', '每次抽奖消耗安慰积分'], ['lotteryDailyLimit', '每日抽奖次数', '', '0 为禁用抽奖。'],
  ] },
];

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function renderForm() {
  const container = $('#rule-groups');
  for (const [index, group] of groups.entries()) {
    const section = makeElement('section', 'panel rule-group');
    const heading = makeElement('div', 'section-heading');
    heading.append(makeElement('h2', '', group.title), makeElement('span', 'group-number', String(index + 1).padStart(2, '0')));
    section.append(heading, makeElement('p', 'muted', group.intro));
    const grid = makeElement('div', 'field-grid');
    for (const [key, title, type, hint] of group.fields) {
      const label = makeElement('label', type === 'checkbox' ? 'field switch-field' : 'field');
      label.htmlFor = `rule-${key}`;
      label.append(makeElement('span', 'field-label', title));
      let control;
      if (type === 'select') {
        control = makeElement('select');
        for (const [value, text] of [['probability', '概率模式 · 系统公开抽取结果档'], ['skill', '纯操作模式 · 按实际表现结算']]) {
          const option = makeElement('option', '', text); option.value = value; control.append(option);
        }
      } else {
        control = makeElement('input'); control.type = type === 'checkbox' ? 'checkbox' : 'number';
        if (type !== 'checkbox') {
          const [min, max, integer] = RULE_LIMITS[key];
          control.min = min; control.max = max; control.step = integer ? '1' : 'any';
        }
      }
      control.id = `rule-${key}`; control.name = key;
      label.append(control);
      if (hint) label.append(makeElement('small', '', hint));
      grid.append(label);
    }
    section.append(grid); container.append(section);
  }
}

function fillForm(rules) {
  for (const [key, value] of Object.entries(rules)) {
    const element = form.elements.namedItem(key);
    if (!element) continue;
    if (element.type === 'checkbox') element.checked = value;
    else element.value = value;
    element.removeAttribute('aria-invalid');
  }
}

function readForm() {
  const draft = {};
  for (const [key, defaultValue] of Object.entries(DEFAULT_RULES)) {
    const element = form.elements.namedItem(key);
    if (typeof defaultValue === 'boolean') draft[key] = element.checked;
    else if (typeof defaultValue === 'number') draft[key] = element.value.trim() === '' ? NaN : Number(element.value);
    else draft[key] = element.value;
  }
  return normalizeRules(draft);
}

function showMessage(text, error = false) {
  const element = $('#message');
  element.textContent = text; element.hidden = false; element.classList.toggle('error', error);
  if (error) element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function markInvalid(error) {
  for (const key of Object.keys(DEFAULT_RULES)) {
    const element = form.elements.namedItem(key);
    const invalid = error.message.includes(key);
    if (invalid) element.setAttribute('aria-invalid', 'true'); else element.removeAttribute('aria-invalid');
  }
}

function renderHistory() {
  const history = loadRulesHistory();
  $('#revision').textContent = history.length ? `已保存版本 ${history[0].revision} · 下局生效` : '默认规则 · 尚未保存';
  const container = $('#history-list'); container.replaceChildren();
  if (!history.length) { container.append(makeElement('p', 'empty', '暂无本机修改记录。')); return; }
  for (const [index, item] of history.entries()) {
    const row = makeElement('div', 'history-row');
    const details = makeElement('div');
    const action = item.action === 'reset' ? '恢复默认' : item.action.startsWith('rollback:') ? `回滚版本 ${item.action.split(':')[1]}` : '保存规则';
    details.append(makeElement('strong', '', `V${item.revision} · ${action}${index === 0 ? ' · 当前' : ''}`));
    details.append(makeElement('small', '', new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false })));
    row.append(details);
    if (index > 0) {
      const button = makeElement('button', 'ghost small', '回滚'); button.type = 'button';
      button.addEventListener('click', () => {
        try { const saved = rollbackRules(item.revision); fillForm(saved.rules); renderHistory(); showMessage(`已回滚至版本 ${item.revision} 的规则，保存为版本 ${saved.revision}，下一局生效。`); }
        catch (error) { showMessage(error.message, true); }
      });
      row.append(button);
    }
    container.append(row);
  }
}

const number = value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
const percent = value => `${number(value)}%`;

function renderSimulation(result) {
  const container = $('#simulation-result'); container.replaceChildren();
  const metrics = makeElement('div', 'metrics');
  for (const [title, value] of [['模拟返还率', percent(result.returnRate * 100)], ['模板理论返还率', percent(result.theoreticalReturnRate * 100)], ['模拟净留存', number(result.netUnits)], ['最高倍率出现', `${percent(result.peakPercent)} / ${number(result.peakCount)} 局`]]) {
    const card = makeElement('div', 'metric'); card.append(makeElement('small', '', title), makeElement('strong', '', value)); metrics.append(card);
  }
  container.append(metrics);
  const summary = makeElement('div', 'summary-split');
  for (const [label, value, cls] of [['亏', result.lossPercent, 'loss'], ['保', result.breakEvenPercent, 'even'], ['盈', result.winPercent, 'win']]) summary.append(makeElement('span', cls, `${label} ${percent(value)}`));
  container.append(summary);
  const chart = makeElement('div', 'distribution-chart');
  const labels = { loss: '全损', breakEven: '保本', smallWin: '小赚', double: '翻倍', highWin: '高倍' };
  for (const [key, band] of Object.entries(result.bands)) {
    const row = makeElement('div', `bar-row ${key}`);
    const top = makeElement('div', 'bar-label'); top.append(makeElement('span', '', labels[key]), makeElement('strong', '', `${percent(band.percent)} · ${number(band.count)} 局`));
    const track = makeElement('div', 'bar-track'), fill = makeElement('span'); fill.style.width = `${band.percent}%`; track.append(fill);
    row.append(top, track, makeElement('small', '', `配置 ${percent(band.configuredPercent)}`)); chart.append(row);
  }
  container.append(chart);
  const allocation = makeElement('div', 'allocation'); allocation.append(makeElement('h3', '', '全损门槛模拟分配'));
  for (const [label, value] of [['模拟销毁', result.distribution.burnUnits], ['模拟平台', result.distribution.platformUnits], ['模拟活动', result.distribution.activityUnits]]) {
    const row = makeElement('p'); row.append(makeElement('span', '', label), makeElement('strong', '', `${number(value)} 分`)); allocation.append(row);
  }
  allocation.append(makeElement('small', '', '以上只是全损积分的去向；“净留存”已扣除所有结果返还，可能为负数，不代表真实利润或链上销毁。'));
  container.append(allocation, makeElement('p', 'sim-disclaimer', `${number(result.rounds)} 局 · ${result.mode === 'skill' ? '当前为纯操作模式，此处仅展示概率模板。' : '系统概率模板。'} ${result.note}`));
}

renderForm(); fillForm(loadRules()); renderHistory();
form.addEventListener('input', () => { $('#revision').textContent = '表单有改动 · 尚未保存'; });
form.addEventListener('submit', event => {
  event.preventDefault();
  try { const saved = saveRules(readForm()); fillForm(saved.rules); renderHistory(); showMessage(`规则已保存为版本 ${saved.revision}，从下一局生效。`); }
  catch (error) { markInvalid(error); showMessage(error.message, true); }
});
$('#restore').addEventListener('click', () => {
  try { const saved = resetRules(); fillForm(saved.rules); renderHistory(); showMessage(`已恢复默认规则并保存为版本 ${saved.revision}，从下一局生效。`); }
  catch (error) { showMessage(error.message, true); }
});
$('#simulate').addEventListener('click', async () => {
  const button = $('#simulate'); button.disabled = true; button.textContent = '试算中…';
  try {
    const rules = readForm();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    renderSimulation(simulateRules(rules, Number($('#rounds').value)));
    showMessage('试算完成。试算使用当前表单的结果模板，未保存或消耗积分。');
  } catch (error) { markInvalid(error); showMessage(error.message, true); }
  finally { button.disabled = false; button.textContent = '运行试算 ↗'; }
});
window.addEventListener('storage', event => {
  if (event.key?.includes('run-aix:v3:rules')) showMessage('另一个标签页修改了本机规则。刷新此页可读取新规则；当前表单保留。');
});

// 障碍库独立保存，避免修改相对权重时改变收益概率或进行中的对局。
const catalogForm = $('#catalog-form');
let catalogDraft = structuredClone(loadCatalog());
const sceneLabels = ['星空', '大厅', '海域'];
const catalogSelect = $('#catalog-selected');
for (const hazard of HAZARDS) {
  const option = makeElement('option', '', hazard.name); option.value = hazard.id; catalogSelect.append(option);
}
function catalogMessage(text, error = false) {
  const message = $('#catalog-message'); message.hidden = false; message.textContent = text; message.classList.toggle('error', error);
}
function fillCatalogEditor() {
  const value = catalogDraft[catalogSelect.value]; if (!value) return;
  $('#catalog-enabled').checked = value.enabled;
  for (const key of ['weight', 'minDistance', 'behavior', 'line']) $(`#catalog-${key}`).value = value[key];
  for (const key of ['lanes', 'scenes']) catalogForm.querySelectorAll(`[name="${key}"]`).forEach(input => { input.checked = value[key].includes(Number(input.value)); });
}
function updateCatalogCount() {
  const count = Object.values(catalogDraft).filter(value=>value.enabled && value.weight > 0).length;
  $('#catalog-count').textContent = `${count} / ${HAZARDS.length} 项有效`;
}
function renderCatalogList() {
  const container = $('#catalog-list'); container.replaceChildren();
  for (const hazard of HAZARDS) {
    const value = catalogDraft[hazard.id];
    const row = makeElement('div', `catalog-row${hazard.id === catalogSelect.value ? ' selected' : ''}`);
    const enabledInput = makeElement('input'); enabledInput.type = 'checkbox'; enabledInput.checked = value.enabled; enabledInput.setAttribute('aria-label', `启用 ${hazard.name}`);
    enabledInput.addEventListener('change', () => { value.enabled = enabledInput.checked; markCatalogDirty(); fillCatalogEditor(); renderCatalogList(); });
    const details = makeElement('button', 'catalog-row-select'); details.type = 'button';
    details.append(makeElement('strong', '', hazard.name), makeElement('small', '', `${value.minDistance}m · 场景 ${value.scenes.map(index=>sceneLabels[index]).join('/')} · 车道 ${value.lanes.map(index=>['左','中','右'][index]).join('/')}`), makeElement('span', 'catalog-line-preview', value.line || '（无受击台词）'));
    details.addEventListener('click', () => { catalogSelect.value = hazard.id; fillCatalogEditor(); renderCatalogList(); catalogSelect.focus({preventScroll:true}); });
    const weightLabel = makeElement('label', 'catalog-weight'); weightLabel.append(makeElement('span', '', '权重'));
    const weight = makeElement('input'); weight.type = 'number'; weight.min = 0; weight.max = 100; weight.step = 'any'; weight.value = value.weight; weight.setAttribute('aria-label', `${hazard.name} 相对权重`);
    weight.addEventListener('input', () => { value.weight = weight.value.trim() === '' ? NaN : Number(weight.value); markCatalogDirty(); updateCatalogCount(); if (hazard.id === catalogSelect.value) $('#catalog-weight').value = weight.value; });
    weightLabel.append(weight); row.append(enabledInput, details, weightLabel); container.append(row);
  }
  updateCatalogCount();
}
function markCatalogDirty() { $('#catalog-revision').textContent = '障碍草稿有改动 · 尚未保存'; }
function readCatalogEditor() {
  const value = catalogDraft[catalogSelect.value];
  value.enabled = $('#catalog-enabled').checked;
  for (const key of ['weight','minDistance']) value[key] = $(`#catalog-${key}`).value.trim() === '' ? NaN : Number($(`#catalog-${key}`).value);
  value.behavior = $('#catalog-behavior').value; value.line = $('#catalog-line').value;
  for (const key of ['lanes','scenes']) value[key] = [...catalogForm.querySelectorAll(`[name="${key}"]:checked`)].map(input=>Number(input.value));
}
function renderCatalogHistory() {
  const history = loadCatalogHistory(), select = $('#catalog-history'); select.replaceChildren();
  $('#catalog-revision').textContent = history.length ? `障碍版本 ${history[0].revision} · 下局生效` : '默认障碍库 · 尚未保存';
  if (history.length < 2) { const option = makeElement('option', '', '暂无可回滚的旧版本'); option.value = ''; select.append(option); }
  for (const item of history.slice(1)) {
    const action = item.action === 'reset' ? '恢复默认' : item.action.startsWith('rollback:') ? '回滚保存' : '保存';
    const option = makeElement('option', '', `V${item.revision} · ${new Date(item.updatedAt).toLocaleString('zh-CN',{hour12:false})} · ${action}`); option.value = item.revision; select.append(option);
  }
  $('#catalog-rollback').disabled = history.length < 2;
}
function applySavedCatalog(saved, message) {
  catalogDraft = structuredClone(saved.catalog); fillCatalogEditor(); renderCatalogList(); renderCatalogHistory(); catalogMessage(`${message}，保存为障碍版本 ${saved.revision}，从下一局生效。`);
}
catalogSelect.addEventListener('change', () => { fillCatalogEditor(); renderCatalogList(); });
catalogForm.addEventListener('input', () => { readCatalogEditor(); markCatalogDirty(); renderCatalogList(); });
catalogForm.addEventListener('submit', event => {
  event.preventDefault();
  try { readCatalogEditor(); const validated = validateCatalog(catalogDraft); applySavedCatalog(saveCatalog(validated), '障碍库已保存'); }
  catch (error) { catalogMessage(error.message, true); }
});
$('#catalog-reset').addEventListener('click', () => {
  try { applySavedCatalog(resetCatalog(), '已恢复默认障碍库'); }
  catch (error) { catalogMessage(error.message, true); }
});
$('#catalog-rollback').addEventListener('click', () => {
  try { const revision = Number($('#catalog-history').value); applySavedCatalog(rollbackCatalog(revision), `已回滚至障碍版本 ${revision}`); }
  catch (error) { catalogMessage(error.message, true); }
});
window.addEventListener('storage', event => {
  if (event.key === CATALOG_STORAGE_KEY) catalogMessage('另一个标签页修改了障碍库。刷新此页可读取新配置；当前草稿保留。');
});
fillCatalogEditor(); renderCatalogList(); renderCatalogHistory();
