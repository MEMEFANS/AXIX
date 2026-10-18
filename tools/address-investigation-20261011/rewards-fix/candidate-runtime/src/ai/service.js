// Deterministic, read-only quantitative analysis. No model or cloud API is used.
import { notify, getAiConfig } from './provider.js';
import { analyzeTrend } from '../trend.js';
import { loadSnapshot, saveSnapshot } from '../persist.js';

const KEYS = ['de', 'ex', 'rs'];
const EXNAMES = { de: 'Decibel', ex: 'Extended', rs: 'RISEx' };
const LEVEL_SCORE = { ok: 0, warn: 1, critical: 2 };
const round = (n, d = 2) => Number.isFinite(Number(n)) ? Number(Number(n).toFixed(d)) : null;
const pct = (n) => `${round(Number(n) || 0, 2)}%`;

export function createAiService({ bots, exchanges }) { return new RuleAnalysisService(bots, exchanges); }

class RuleAnalysisService {
  constructor(bots, exchanges) {
    this.bots = bots;
    this.exchanges = exchanges;
    this.sentinel = null;
    this.sentinelHistory = [];
    this.sentinelError = null;
    this.report = null;
    this.market = null;
    this.marketError = null;
    this.oorAdvice = {};
    this._busy = { sentinel: false, report: false, market: false };
    this._prevOor = {};
    this._lastPushLevel = 'ok';
    this._lastPushAt = 0;
    const saved = loadSnapshot('ai') || {};
    this.report = saved.report || null;
    this.market = saved.market || null;
    this._baseline = saved.baseline || null;
    this._reportDoneDay = saved.reportDoneDay || null;
  }

  start() {
    this._lastSentinelAt = 0;
    this._timer = setInterval(() => this._tick().catch(() => {}), 60_000);
    this._timer.unref?.();
    this._oorTimer = setInterval(() => this._checkOutOfRange().catch(() => {}), 30_000);
    this._oorTimer.unref?.();
    if (!this._baseline) this._rebaseline();
  }

  stop() {
    clearInterval(this._timer); clearInterval(this._oorTimer);
    this._timer = null; this._oorTimer = null;
  }

  async _tick() {
    const cfg = getAiConfig();
    const now = Date.now();
    if (cfg.sentinelMin > 0 && now - this._lastSentinelAt >= cfg.sentinelMin * 60_000) {
      this._lastSentinelAt = now; await this.runSentinel();
    }
    const lastMarket = Math.max(this._lastMarketAt || 0, this.market?.t || 0);
    if (cfg.marketMin > 0 && now - lastMarket >= cfg.marketMin * 60_000) {
      this._lastMarketAt = now; await this.runMarketAnalysis().catch(() => {});
    }
    const d = new Date(), day = d.toISOString().slice(0, 10);
    if (cfg.reportHour >= 0 && d.getHours() === cfg.reportHour && this._reportDoneDay !== day) {
      this._reportDoneDay = day; this._save(); await this.makeReport();
    }
  }

  _snapshot() {
    return Object.fromEntries(KEYS.map((key) => {
      const s = this.bots[key].getState();
      return [key, {
        exchange: EXNAMES[key], tradeMode: s.mode, running: s.running, recovery: s.recovery,
        market: s.config?.displayName || null, health: s.health || null,
        lastPrice: s.lastPrice, outOfRange: s.outOfRange, equity: s.equity, balance: s.balance,
        realizedPnl: s.realizedPnl, unrealizedPnl: s.unrealizedPnl, returnPct: s.returnPct,
        position: s.position, trackedOrders: s.openOrders, exchangeOpenOrders: s.exchangeOpenOrders,
        completedRungs: s.stats?.completedRungs || 0, volume: s.volume || 0,
        gridConfig: s.config ? { mode: s.config.mode, lower: s.config.lower, upper: s.config.upper,
          gridCount: s.config.gridCount, sizeBase: s.config.sizeBase, leverage: s.config.leverage,
          outOfRangeAction: s.config.outOfRangeAction } : null,
        recentAlerts: (s.alerts || []).slice(0, 5).map((a) => String(a.message || '')),
      }];
    }));
  }

  _riskFor(s) {
    if (!s.running) return { level: 'ok', summary: '未运行', advice: '' };
    const issues = [], advice = [];
    let level = 'ok';
    const raise = (next) => { if (LEVEL_SCORE[next] > LEVEL_SCORE[level]) level = next; };
    const health = String(s.health?.status || '').toLowerCase();
    if (health === 'error') { raise('critical'); issues.push(`连接异常：${s.health?.reason || '未知原因'}`); advice.push('检查网络和交易所连接'); }
    else if (health === 'warn') { raise('warn'); issues.push(`连接告警：${s.health?.reason || '状态不稳定'}`); }
    if (s.outOfRange) { raise('warn'); issues.push('价格已脱离网格区间'); advice.push('复核出区间策略和持仓风险'); }
    const orderGap = Math.abs((Number(s.trackedOrders) || 0) - (Number(s.exchangeOpenOrders) || 0));
    if (orderGap >= 3) { raise(orderGap >= 6 ? 'critical' : 'warn'); issues.push(`挂单记录相差 ${orderGap} 笔`); advice.push('核对交易所实际挂单'); }
    const lossRatio = s.equity > 0 && s.unrealizedPnl < 0 ? Math.abs(s.unrealizedPnl) / s.equity : 0;
    if (lossRatio >= 0.2 || Number(s.returnPct) <= -20) { raise('critical'); issues.push(`浮亏占权益 ${pct(lossRatio * 100)}`); advice.push('优先控制仓位和杠杆'); }
    else if (lossRatio >= 0.08 || Number(s.returnPct) <= -8) { raise('warn'); issues.push(`浮亏占权益 ${pct(lossRatio * 100)}`); advice.push('关注回撤扩大'); }
    const alerts = s.recentAlerts.join(' ');
    if (/保证金不足|接口异常|未确认成交|频繁取消/.test(alerts)) { raise('critical'); issues.push('近期存在关键交易告警'); }
    else if (/暂停补单|超时|失败|异常/.test(alerts)) { raise('warn'); issues.push('近期存在运行告警'); }
    return { level, summary: issues.length ? issues.join('；') : '运行正常，未发现规则风险', advice: [...new Set(advice)].join('；') };
  }

  async runSentinel() {
    if (this._busy.sentinel) return this.sentinel;
    this._busy.sentinel = true;
    try {
      const snap = this._snapshot();
      const per = Object.fromEntries(KEYS.map((key) => [key, this._riskFor(snap[key])]));
      const level = KEYS.reduce((worst, key) => LEVEL_SCORE[per[key].level] > LEVEL_SCORE[worst] ? per[key].level : worst, 'ok');
      const affected = KEYS.filter((key) => per[key].level !== 'ok').map((key) => EXNAMES[key]);
      this.sentinel = { t: Date.now(), level, summary: affected.length ? `${affected.join('、')} 发现需要关注的风险` : '三所规则巡检未发现异常', per };
      this.sentinelHistory.unshift(this.sentinel); this.sentinelHistory = this.sentinelHistory.slice(0, 20);
      this.sentinelError = null;
      if (level !== 'ok' && (level !== this._lastPushLevel || Date.now() - this._lastPushAt > 30 * 60_000)) {
        this._lastPushLevel = level; this._lastPushAt = Date.now();
        const detail = KEYS.filter((k) => per[k].level !== 'ok').map((k) => `${EXNAMES[k]}：${per[k].summary}`).join('\n');
        notify(`【网格规则风控·${level === 'critical' ? '严重' : '注意'}】${this.sentinel.summary}\n${detail}`).catch(() => {});
      }
      if (level === 'ok') this._lastPushLevel = 'ok';
      return this.sentinel;
    } catch (e) { this.sentinelError = e?.message || String(e); return null; }
    finally { this._busy.sentinel = false; }
  }

  _rebaseline() {
    this._baseline = { t: Date.now(), per: Object.fromEntries(KEYS.map((key) => {
      const s = this.bots[key].getState();
      return [key, { equity: s.equity, realizedPnl: s.realizedPnl, completedRungs: s.stats?.completedRungs || 0, volume: s.volume || 0 }];
    })) };
    this._save();
  }

  async makeReport() {
    if (this._busy.report) return this.report;
    this._busy.report = true;
    try {
      const snap = this._snapshot(), base = this._baseline;
      const hours = base ? round((Date.now() - base.t) / 3600_000, 1) : null;
      const lines = [`规则复盘（${hours == null ? '本期' : `近 ${hours} 小时`}）`];
      for (const key of KEYS) {
        const s = snap[key], b = base?.per?.[key] || {};
        if (!s.running && !s.gridConfig) { lines.push(`${EXNAMES[key]}：未运行。`); continue; }
        const realized = round((Number(s.realizedPnl) || 0) - (Number(b.realizedPnl) || 0));
        const equity = Number.isFinite(Number(b.equity)) ? round((Number(s.equity) || 0) - Number(b.equity)) : null;
        const rungs = (s.completedRungs || 0) - (b.completedRungs || 0);
        const risk = this._riskFor(s);
        lines.push(`${EXNAMES[key]}（${s.tradeMode === 'paper' ? '模拟盘' : '实盘'}）：权益变化 ${equity ?? '--'}，已实现变化 ${realized}，完成 ${rungs} 格，浮动盈亏 ${round(s.unrealizedPnl) ?? '--'}；${risk.summary}。`);
      }
      const warnings = lines.filter((line) => /异常|风险|脱离|浮亏占|告警/.test(line)).length;
      lines.push(warnings ? '建议：先处理连接、挂单同步或回撤问题，再考虑扩大网格。' : '建议：继续观察成交密度；若长期无成交，可结合波动率复核区间和格距。');
      this.report = { t: Date.now(), text: lines.join('\n') };
      this._rebaseline();
      notify('【网格机器人·规则复盘】\n' + this.report.text).catch(() => {});
      return this.report;
    } finally { this._busy.report = false; }
  }

  async _regime(key, marketId, ctx = {}) {
    const ex = this.exchanges[key];
    const market = (await ex.getMarkets()).find((m) => Number(m.marketId) === Number(marketId));
    const frames = {};
    for (const [label, sec] of [['4小时', 14400], ['1小时', 3600], ['15分钟', 900]]) {
      try {
        const candles = await ex.getCandles(marketId, sec, 200);
        if (candles?.length >= 30) {
          const a = analyzeTrend(candles);
          frames[label] = { trend: a.trend, strength: a.strength, slopePct: a.slopePct, atrPct: a.atrPct,
            emaGap: a.emaFast && a.emaSlow ? round((a.emaFast - a.emaSlow) / a.emaSlow * 100) : null };
        }
      } catch { /* one timeframe can fail */ }
    }
    if (!Object.keys(frames).length) throw new Error('拿不到足够的K线数据，无法分析。');
    const price = Number(await ex.getPrice(marketId).catch(() => null));
    const values = Object.values(frames), up = values.filter((f) => f.trend === 'up').length, down = values.filter((f) => f.trend === 'down').length;
    const avgAtr = values.reduce((n, f) => n + (Number(f.atrPct) || 0), 0) / values.length;
    const avgStrength = values.reduce((n, f) => n + (Number(f.strength) || 0), 0) / values.length;
    const violent = avgAtr >= 4;
    const directional = Math.max(up, down) >= 2 && avgStrength >= 0.35;
    const regime = violent ? '剧烈波动' : directional ? (up > down ? '上升趋势' : '下降趋势') : '震荡';
    const suitable = !violent && !directional;
    const recommendMode = directional ? (up > down ? 'long' : 'short') : 'neutral';
    const widthPct = Math.max(2, Math.min(20, avgAtr * 3 || 4));
    const lower = price > 0 ? round(price * (1 - widthPct / 100), 6) : null;
    const upper = price > 0 ? round(price * (1 + widthPct / 100), 6) : null;
    const spacing = round(Math.max(0.15, avgAtr * 0.5), 3);
    const gridCount = Math.max(4, Math.min(80, Math.round((widthPct * 2) / spacing)));
    const reasoning = `${values.length} 个周期中，上升 ${up}、下降 ${down}、震荡 ${values.length - up - down}；平均 ATR ${pct(avgAtr)}，趋势强度 ${pct(avgStrength * 100)}。`;
    const caution = suitable ? '规则只基于历史K线指标，震荡状态也可能快速转为单边行情。' : '单边趋势或高波动下，网格容易积累方向性持仓和浮亏。';
    return { t: Date.now(), source: EXNAMES[key], market: market?.displayName, price, frames, regime, suitable,
      recommendMode, confidence: round(Math.max(0.5, Math.min(0.95, 0.55 + avgStrength * 0.35)), 2),
      suggestedRange: lower && upper ? { lower, upper } : null, suggestedGridCount: gridCount,
      suggestedSpacingPct: spacing, reasoning, caution, currentGrid: ctx.gridCfg || null };
  }

  async analyze(key) {
    const bot = this.bots[key], ex = this.exchanges[key];
    if (!bot || !ex) throw new Error('未知交易所: ' + key);
    let marketId = bot.config?.marketId;
    if (marketId == null) marketId = (await ex.getMarkets())[0]?.marketId;
    if (marketId == null) throw new Error('该交易所没有可分析的市场。');
    const st = bot.getState();
    return this._regime(key, marketId, { gridCfg: st.config, running: st.running });
  }

  async runMarketAnalysis() {
    if (this._busy.market) return this.market;
    this._busy.market = true;
    try {
      let source = null, marketId = null;
      for (const key of ['ex', 'de', 'rs']) {
        const ex = this.exchanges[key];
        if (ex.dataSource !== 'real') continue;
        const markets = await ex.getMarkets().catch(() => []);
        const btc = markets.find((m) => String(m.symbol || m.displayName || '').toUpperCase().startsWith('BTC'));
        if (btc) { source = key; marketId = btc.marketId; break; }
      }
      if (!source) throw new Error('没有可用的真实 BTC 行情来源。');
      this.market = await this._regime(source, marketId);
      this.marketError = null; this._save(); return this.market;
    } catch (e) { this.marketError = e?.message || String(e); throw e; }
    finally { this._busy.market = false; }
  }

  async chatAdvice(message) {
    const snap = this._snapshot();
    const query = String(message || '');
    const risks = Object.fromEntries(KEYS.map((k) => [k, this._riskFor(snap[k])]));
    let reply;
    if (/盈亏|收益|表现|复盘/.test(query)) {
      reply = KEYS.map((k) => `${EXNAMES[k]}：已实现 ${round(snap[k].realizedPnl) ?? '--'}，浮动 ${round(snap[k].unrealizedPnl) ?? '--'}，收益率 ${pct(snap[k].returnPct)}，完成 ${snap[k].completedRungs} 格。`).join('\n');
    } else if (/区间|网格|参数|格距/.test(query)) {
      reply = KEYS.map((k) => { const s = snap[k], c = s.gridConfig; return c ? `${EXNAMES[k]}：${s.market}，区间 ${c.lower} ~ ${c.upper}，${c.gridCount} 格，现价 ${s.lastPrice ?? '--'}${s.outOfRange ? '（已出区间）' : '（区间内）'}。` : `${EXNAMES[k]}：尚未配置网格。`; }).join('\n');
    } else {
      reply = KEYS.map((k) => `${EXNAMES[k]}：${risks[k].summary}${risks[k].advice ? `；建议 ${risks[k].advice}` : ''}。`).join('\n');
    }
    return { reply: `本地规则分析（只读）：\n${reply}\n提示：这是指标和阈值判断，不是收益保证，也不会执行任何交易。`, readOnly: true };
  }

  async _checkOutOfRange() {
    for (const key of KEYS) {
      const bot = this.bots[key], current = !!(bot.running && bot.outOfRange), previous = !!this._prevOor[key];
      this._prevOor[key] = current;
      if (current && !previous) this._adviseOutOfRange(key).catch(() => {});
    }
  }

  async _adviseOutOfRange(key) {
    const bot = this.bots[key], ex = this.exchanges[key], st = bot.getState();
    let trend = null;
    try { const c = await ex.getCandles(bot.config.marketId, 3600, 120); if (c?.length >= 51) trend = analyzeTrend(c); } catch {}
    const strong = trend && trend.trend !== 'range' && trend.strength >= 0.55;
    const action = st.config?.outOfRangeAction;
    const suggestion = strong && action !== 'recover' ? 'close' : action === 'recover' ? 'recover' : 'hold';
    const suggestionText = suggestion === 'close' ? '趋势较强，优先控制方向性持仓风险' : suggestion === 'recover' ? '按现有只减仓回收策略等待减仓机会' : '先维持当前策略并密切观察是否重新回到区间';
    const reasoning = trend ? `${trend.detail} 当前自动出区间策略：${action === 'recover' ? '只减仓回收' : '冲破区间平仓'}。` : 'K线数据不足，按已配置的自动出区间策略执行。';
    this.oorAdvice[key] = { t: Date.now(), suggestion, suggestionText, reasoning };
    notify(`【网格规则风控·出区间】${EXNAMES[key]} ${st.config?.displayName}，现价 ${st.lastPrice}。\n建议：${suggestionText}\n依据：${reasoning}`).catch(() => {});
  }

  async test() { return { ok: true, ms: 0, model: '无需模型', provider: '本地规则引擎', localOnly: true, reply: '规则引擎正常' }; }

  async status() {
    const cfg = getAiConfig();
    return { configured: true, available: true, localOnly: true, provider: 'rules', model: '无需模型', modelSmall: '无需模型',
      installedModels: [], telegramTokenMasked: cfg.telegramToken ? cfg.telegramToken.slice(0, 4) + '…' + cfg.telegramToken.slice(-4) : '',
      telegramChat: cfg.telegramChat, webhook: cfg.webhook, sentinelMin: cfg.sentinelMin, marketMin: cfg.marketMin,
      reportHour: cfg.reportHour, notifyChannels: [cfg.telegramToken && cfg.telegramChat ? 'telegram' : null, cfg.webhook ? 'webhook' : null].filter(Boolean),
      sentinel: this.sentinel, sentinelError: this.sentinelError, sentinelHistory: this.sentinelHistory.slice(0, 10),
      report: this.report, market: this.market, marketError: this.marketError, oorAdvice: this.oorAdvice };
  }

  _save() { try { saveSnapshot('ai', { report: this.report, market: this.market, baseline: this._baseline, reportDoneDay: this._reportDoneDay }); } catch {} }
}
