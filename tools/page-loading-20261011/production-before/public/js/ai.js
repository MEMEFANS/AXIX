// ══ AI 助手 ═══════════════════════════════════════════════════════════════
const AI_ENV_MAP = {
  'ai-sentinel-min':'AI_SENTINEL_MINUTES', 'ai-market-min':'AI_MARKET_MINUTES', 'ai-report-hour':'AI_REPORT_HOUR',
  'ai-tg-token':'TELEGRAM_BOT_TOKEN', 'ai-tg-chat':'TELEGRAM_CHAT_ID', 'ai-webhook':'NOTIFY_WEBHOOK',
};
const AI_EXNAME = { de:'Decibel', ex:'Extended', rs:'RISEx' };
let aiChatHistory = [];

async function aiSaveConfig(btn) {
  if (btn) btn.disabled = true;
  let saved = 0;
  try {
    const items = [];
    for (const [id, key] of Object.entries(AI_ENV_MAP)) {
      const v = $(id).value.trim();
      if (v) items.push([key, v]); // 留空不覆盖已有配置
    }
    for (const [key, value] of items) {
      const r = await fetch('/api/env', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key, value }) });
      const j = await r.json();
      if (j.error) { $('ai-cfg-status').textContent = `❌ ${key}：${j.error}`; if (btn) btn.disabled = false; return; }
      saved++;
    }
    $('ai-cfg-status').textContent = saved ? `✅ 已保存 ${saved} 项并立即生效（已写入 .env）` : '未填写任何内容，无变更。';
    aiRefreshStatus();
  } catch (e) { $('ai-cfg-status').textContent = '❌ 保存失败：' + e.message; }
  if (btn) btn.disabled = false;
}

async function aiTest(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
  try {
    const r = await fetch('/api/ai/test', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    const j = await r.json();
    $('ai-cfg-status').textContent = j.ok
      ? `✅ ${j.provider}正常 · ${j.reply}`
      : `❌ 检测失败：${j.error}`;
  } catch (e) { $('ai-cfg-status').textContent = '❌ 测试失败：' + e.message; }
  if (btn) { btn.disabled = false; btn.textContent = '检测规则引擎'; }
}

function aiFmtTime(t) { return t ? new Date(t).toLocaleString('zh-CN', { hour12:false }) : ''; }

async function aiRefreshStatus() {
  try {
    const r = await fetch('/api/ai/status');
    const s = await r.json();
    // ── 已保存的本地配置回填（仅页面加载后执行一次）──
    if (!window._aiCfgFilled) {
      window._aiCfgFilled = true;
      $('ai-sentinel-min').value = s.sentinelMin ?? '';
      $('ai-market-min').value = s.marketMin ?? '';
      $('ai-report-hour').value = s.reportHour ?? '';
      if (s.telegramChat) $('ai-tg-chat').value = s.telegramChat;
      if (s.webhook) $('ai-webhook').value = s.webhook;
      if (s.telegramTokenMasked) $('ai-tg-token').placeholder = `已保存（${s.telegramTokenMasked}），留空表示不修改`;
    }
    $('ai-sentinel-min').placeholder = s.sentinelMin;
    $('ai-market-min').placeholder = s.marketMin;
    $('ai-report-hour').placeholder = s.reportHour;
    const chans = (s.notifyChannels || []).join(' + ') || '未配置';
    $('ai-cfg-status').textContent = `本地规则引擎已就绪（巡检每 ${s.sentinelMin} 分钟 · 行情每 ${s.marketMin} 分钟 · 日报 ${s.reportHour} 点 · 推送渠道：${chans}）`;
    // 哨兵
    const badge = $('ai-sent-badge');
    if (s.sentinel) {
      const lv = s.sentinel.level;
      badge.innerHTML = `<span class="ai-badge ${lv}">${lv === 'ok' ? '正常' : lv === 'warn' ? '注意' : '严重'}</span>`;
      $('ai-sentinel-box').className = 'ai-box';
      let sentTxt = `[巡检时间 ${aiFmtTime(s.sentinel.t)}] ${s.sentinel.summary}`;
      if (s.sentinel.per) {
        for (const [k, v] of Object.entries(s.sentinel.per)) {
          if (!v) continue;
          const icon = v.level === 'ok' ? '🟢' : v.level === 'warn' ? '🟡' : '🔴';
          sentTxt += `\n${icon} ${AI_EXNAME[k] || k}：${v.summary || ''}${v.advice ? `（建议：${v.advice}）` : ''}`;
        }
      } else {
        if (s.sentinel.detail) sentTxt += `\n问题：${s.sentinel.detail}`;
        if (s.sentinel.advice) sentTxt += `\n建议：${s.sentinel.advice}`;
      }
      $('ai-sentinel-box').textContent = sentTxt;
    } else if (s.sentinelError) {
      badge.innerHTML = '';
      $('ai-sentinel-box').textContent = '巡检出错：' + s.sentinelError;
    }
    // ── 总览页：BTC 市况报告 + 各所哨兵报告 ──
    if ($('ov-ai-market')) {
      if (s.market) {
        $('ov-ai-mkt-time').textContent = `分析时间 ${aiFmtTime(s.market.t)} · 数据源 ${s.market.source || ''} · 每 ${s.marketMin} 分钟自动更新`;
        $('ov-ai-market').className = 'ai-box';
        $('ov-ai-market').textContent = aiRegimeText(s.market);
      } else if (s.marketError) {
        $('ov-ai-market').textContent = '上次分析失败：' + s.marketError;
      }
      if (document.activeElement !== $('ov-ai-mkt-min')) $('ov-ai-mkt-min').placeholder = s.marketMin;
      if (document.activeElement !== $('ov-ai-sent-min')) $('ov-ai-sent-min').placeholder = s.sentinelMin;
      for (const p of ['de', 'ex', 'rs']) {
        const el = $(`ov-${p}-ai`);
        const per = s.sentinel && s.sentinel.per ? s.sentinel.per[p] : null;
        if (el && per) {
          el.style.display = '';
          el.classList.remove('muted');
          const icon = per.level === 'ok' ? '🟢' : per.level === 'warn' ? '🟡' : '🔴';
          el.textContent = `${icon} 规则风控 · 巡检时间 ${aiFmtTime(s.sentinel.t)}\n${per.summary || ''}${per.advice ? `\n建议：${per.advice}` : ''}`;
        }
      }
    }
    // 出区间建议
    const oorKeys = Object.keys(s.oorAdvice || {});
    if (oorKeys.length) {
      $('ai-oor-box').className = 'ai-box';
      $('ai-oor-box').textContent = oorKeys.map((k) => {
        const a = s.oorAdvice[k];
        return `[${aiFmtTime(a.t)}] ${AI_EXNAME[k]}：${a.suggestionText || a.suggestion}\n理由：${a.reasoning || ''}`;
      }).join('\n\n');
    }
    // 日报
    if (s.report) {
      $('ai-report-box').className = 'ai-box';
      $('ai-report-box').textContent = `[${aiFmtTime(s.report.t)}]\n${s.report.text}`;
    }
  } catch { /* 后端未就绪 */ }
}

async function aiSentinelRun(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '巡检中…'; }
  try {
    const r = await fetch('/api/ai/sentinel-run', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    const j = await r.json();
    if (j.error) alert('巡检失败：' + j.error); else aiRefreshStatus();
  } catch (e) { alert('巡检失败：' + e.message); }
  if (btn) { btn.disabled = false; btn.textContent = '立即巡检一次'; }
}

async function aiReport(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  try {
    const r = await fetch('/api/ai/report', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    const j = await r.json();
    if (j.error) alert('生成失败：' + j.error); else aiRefreshStatus();
  } catch (e) { alert('生成失败：' + e.message); }
  if (btn) { btn.disabled = false; btn.textContent = '立即生成日报'; }
}

async function aiAnalyze(p, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '分析中…'; }
  const box = $('ai-analyze-box');
  try {
    const r = await fetch('/api/ai/analyze', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ex: p }) });
    const j = await r.json();
    if (j.error) { box.textContent = '❌ ' + j.error; }
    else {
      box.className = 'ai-box';
      box.textContent =
        `【${AI_EXNAME[p]} · ${j.market} · 现价 ${j.price}】\n` +
        `市况：${j.regime} · ${j.suitable ? '✅ 适合跑网格' : '⛔ 当前不适合跑网格'} · 置信度 ${Math.round((j.confidence || 0) * 100)}%\n` +
        `建议模式：${j.recommendMode === 'long' ? '做多网格' : j.recommendMode === 'short' ? '做空网格' : '中性网格'}` +
        (j.suggestedRange ? ` · 区间 ${j.suggestedRange.lower} ~ ${j.suggestedRange.upper}` : '') +
        (j.suggestedGridCount ? ` · ${j.suggestedGridCount} 格` : '') +
        (j.suggestedSpacingPct ? ` · 间距约 ${j.suggestedSpacingPct}%` : '') +
        `\n分析：${j.reasoning || ''}` +
        (j.caution ? `\n⚠️ ${j.caution}` : '');
    }
  } catch (e) { box.textContent = '❌ 分析失败：' + e.message; }
  if (btn) { btn.disabled = false; btn.textContent = '分析 ' + AI_EXNAME[p]; }
}

function aiChatAppend(cls, text) {
  const log = $('ai-chatlog');
  const div = document.createElement('div');
  div.className = 'ai-msg ' + cls;
  div.textContent = text; // textContent 防注入
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

async function aiChatSend() {
  const input = $('ai-chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  aiChatAppend('user', msg);
  aiChatHistory.push({ role:'user', content: msg });
  const waiting = aiChatAppend('sys', '规则分析中…');
  try {
    const r = await fetch('/api/ai/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message: msg, history: aiChatHistory.slice(0, -1) }) });
    const j = await r.json();
    waiting.remove();
    if (j.error) { aiChatAppend('sys', '❌ ' + j.error); return; }
    aiChatAppend('bot', j.reply || '（空回复）');
    aiChatHistory.push({ role:'assistant', content: j.reply || '' });
    if (aiChatHistory.length > 16) aiChatHistory = aiChatHistory.slice(-16);
  } catch (e) { waiting.remove(); aiChatAppend('sys', '❌ 请求失败：' + e.message); }
}

// 市况报告文本（总览页/复用）
function aiRegimeText(j) {
  return `【${j.market} · 现价 ${j.price}】\n` +
    `市况：${j.regime} · ${j.suitable ? '✅ 适合跑网格' : '⛔ 当前不适合跑网格'} · 置信度 ${Math.round((j.confidence || 0) * 100)}%\n` +
    `建议模式：${j.recommendMode === 'long' ? '做多网格' : j.recommendMode === 'short' ? '做空网格' : '中性网格'}` +
    (j.suggestedRange ? ` · 区间 ${j.suggestedRange.lower} ~ ${j.suggestedRange.upper}` : '') +
    (j.suggestedGridCount ? ` · ${j.suggestedGridCount} 格` : '') +
    (j.suggestedSpacingPct ? ` · 间距约 ${j.suggestedSpacingPct}%` : '') +
    `\n分析：${j.reasoning || ''}` + (j.caution ? `\n⚠️ ${j.caution}` : '');
}

async function aiMarketRun(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '分析中…'; }
  try {
    const r = await fetch('/api/ai/market-run', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    const j = await r.json();
    if (j.error) alert('市况分析失败：' + j.error); else aiRefreshStatus();
  } catch (e) { alert('市况分析失败：' + e.message); }
  if (btn) { btn.disabled = false; btn.textContent = '立即分析'; }
}

async function aiSaveIntervals(btn) {
  if (btn) btn.disabled = true;
  const st = $('ov-ai-int-status');
  try {
    const pairs = [];
    if ($('ov-ai-mkt-min').value.trim() !== '') pairs.push(['AI_MARKET_MINUTES', $('ov-ai-mkt-min').value.trim()]);
    if ($('ov-ai-sent-min').value.trim() !== '') pairs.push(['AI_SENTINEL_MINUTES', $('ov-ai-sent-min').value.trim()]);
    if (!pairs.length) { st.textContent = '未填写，无变更'; if (btn) btn.disabled = false; return; }
    for (const [key, value] of pairs) {
      const r = await fetch('/api/env', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key, value }) });
      const j = await r.json();
      if (j.error) { st.textContent = '❌ ' + j.error; if (btn) btn.disabled = false; return; }
    }
    st.textContent = '✅ 已保存，立即生效';
    $('ov-ai-mkt-min').value = ''; $('ov-ai-sent-min').value = '';
    aiRefreshStatus();
  } catch (e) { st.textContent = '❌ ' + e.message; }
  if (btn) btn.disabled = false;
}

// AI 状态全局轮询（总览页板块 + AI 助手页共用）
aiRefreshStatus();
setInterval(aiRefreshStatus, 30000);

// 钱包配置与已登录会话恢复
loadWalletConfig().then(loadWalletProfile);
