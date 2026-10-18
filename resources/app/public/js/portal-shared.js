// K 线本地时区显示：lightweight-charts v5 移除了 localization.timeZone，
// 时间轴默认按 UTC 渲染（国内差 8 小时），需自定义 tickMarkFormatter / timeFormatter。
// 三张图（现货合约、AIX、策略台）共用此工厂，createChart 时展开合并即可。
window.wgChartTzOptions = function wgChartTzOptions() {
  const tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'Asia/Shanghai';
  const toDate = (t) => {
    if (typeof t === 'number') return new Date(t * 1000);
    if (t && typeof t === 'object') return new Date(Date.UTC(t.year, (t.month || 1) - 1, t.day)); // BusinessDay
    return new Date(Number(t) * 1000);
  };
  const fmt = (d, opt) => d.toLocaleString('zh-CN', Object.assign({ timeZone: tz, hour12: false }, opt));
  // TickMarkType: 0 年 / 1 月 / 2 日 / 3 时分 / 4 时分秒
  const tickMarkFormatter = (t, type) => {
    const d = toDate(t);
    switch (type) {
      case 0: return fmt(d, { year: 'numeric' });
      case 1: return fmt(d, { year: 'numeric', month: '2-digit' });
      case 2: return fmt(d, { month: '2-digit', day: '2-digit' });
      case 4: return fmt(d, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      default: return fmt(d, { hour: '2-digit', minute: '2-digit' });
    }
  };
  const timeFormatter = (t) => fmt(toDate(t), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return {
    localization: { timeFormatter },
    timeScale: { tickMarkFormatter },
  };
};

(function () {
  const pages = {};
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', { maximumFractionDigits:digits }) : '—';
  const money = (value, digits = 2) => Number.isFinite(Number(value)) ? `$${Number(value).toLocaleString('en-US', { minimumFractionDigits:Math.min(2, digits), maximumFractionDigits:digits })}` : '—';
  const percent = (value, scale = 100) => Number.isFinite(Number(value)) ? `${(Number(value) * scale).toFixed(2)}%` : '—';
  const short = (value) => value ? `${String(value).slice(0, 6)}…${String(value).slice(-4)}` : '—';
  const metric = (label, value, note = '') => `<div class="portal-metric"><span>${esc(label)}</span><strong>${value}</strong>${note ? `<small>${esc(note)}</small>` : ''}</div>`;
  const loading = (cols = 4) => `<div class="portal-loading">${'<i></i>'.repeat(cols)}</div>`;
  const ICON_EMPTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';
  const ICON_ERROR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12" y2="16.5"/></svg>';
  const empty = (text = '暂无数据') => `<div class="portal-empty"><span class="portal-empty-ic">${ICON_EMPTY}</span><span>${esc(text)}</span></div>`;
  // retryHandler：调用方提供的全局 JS 语句字符串（常量，无用户输入），点击重试时执行
  const error = (message, retryHandler = '') => `<div class="portal-error"><span class="portal-empty-ic">${ICON_ERROR}</span><span>${esc(message || '数据加载失败')}</span>${retryHandler ? `<button type="button" class="portal-empty-retry" onclick="${esc(retryHandler)}">刷新</button>` : ''}</div>`;
  const walletGate = (text = '连接钱包后查看你的 Hyperliquid 账户数据') => `<div class="portal-gate"><strong>连接钱包</strong><span>${esc(text)}</span><button onclick="connectWallet(this)">连接钱包</button></div>`;
  const platformGate = (text = '连接并确认钱包后查看资金') => `<div class="portal-gate"><strong>连接钱包</strong><span>${esc(text)}</span><button onclick="openPlatformAccount(this)">确认钱包</button></div>`;
  const header = (title, subtitle, actions = '') => `<header class="portal-heading"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${actions}</header>`;

  /**
   * Aethon Fund 方法论背书徽章
   *  - 严格使用"方法论参考"措辞，不表述为股权投资 / 子公司 / LP 关系
   *  - 明确声明 Aethon Fund 未发行代币、无官方 X/Twitter 账号
   *  - 明确 AIX = AxiX 自有品牌原生代币，与 Aethon Fund 不存在任何代币关联
   */
  const aethonBadge = (context = '策略执行框架') => `
    <div class="aethon-badge">
      <div class="aethon-badge-logo" aria-hidden="true">Æ</div>
      <div class="aethon-badge-body">
        <strong><span>Aethon Fund（$50M 启动 · 纽约）—— AxiX </span><span>${context}</span><span>方法论参考</span></strong>
        <span>
          <span>本页</span><span>${context}</span><span>参考了 Aethon Fund 创始人 George Kailas（20 年信号研究 + Prospero.ai 信号库经 20 万+ 散户反馈淬炼 + 7.5× S&P500 实盘）的信号驱动型量化方法论，风控对齐 VRP 叠加层 + 仓位规则化退出的机构级标准。</span>
          <span>详细来源与合规边界见 </span><a href="#" onclick="event.preventDefault(); try { switchTab('whitepaper'); } catch(e){}">白皮书（09 章 AIX 代币边界声明）</a>。
          <br><em style="color:#8fa8a3;font-style:normal">※ Aethon Fund 未发行任何代币，亦无官方 Twitter/X 账号。※ AIX 为 AxiX 自有品牌原生代币，与 Aethon Fund 不存在任何股权/代币/收益权关联。</em>
        </span>
      </div>
      <button class="aethon-badge-cta" type="button" onclick="event.preventDefault(); try { switchTab('whitepaper'); } catch(e){}">查看白皮书 →</button>
    </div>`;

  function register(name, page) {
    pages[name] = { loaded:false, loading:false, requestId:0, ...page };
    page.render?.();
  }

  const active = name => !document.hidden && Boolean(document.getElementById(`tab-${name}`)?.classList.contains('active'));
  const walletKey = () => String(window.currentWalletConnection?.address || window.currentWalletProfile?.address || '').toLowerCase();
  const reads = new Map();
  // Coalesce simultaneous reads, never transactions; do not cache completed balance responses.
  function readJSON(url, options = {}) {
    const { timeoutMs = 10000, dedupe = !options.method || options.method === 'GET', ...init } = options;
    const key = `${walletKey()}:${window.getWalletStateRevision?.() || 0}:${url}:${init.body || ''}`;
    if (dedupe && reads.has(key)) return reads.get(key);
    const promise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abort = () => controller.abort();
      init.signal?.addEventListener('abort', abort, { once:true });
      if (init.signal?.aborted) controller.abort();
      try {
        const response = await fetch(url, { credentials:'same-origin', ...init, signal:controller.signal });
        const data = await response.json();
        if (!response.ok) throw Object.assign(new Error(data.error || `请求失败（${response.status}）`), { status:response.status });
        return data;
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('网络较慢，请求超时，请稍后重试');
        throw error;
      } finally { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); }
    })();
    if (dedupe) {
      reads.set(key, promise);
      promise.finally(() => { if (reads.get(key) === promise) reads.delete(key); }).catch(() => {});
    }
    return promise;
  }

  function invalidate() {
    Object.values(pages).forEach(page => {
      ++page.requestId; page.loaded = false; page.loading = false; page.reset?.();
    });
    reads.clear();
  }

  async function load(name, force = false) {
    const page = pages[name];
    if (!page) return;
    if (!force && (page.loaded || page.loading)) {
      if (page.loaded && active(name)) page.activate?.();
      return;
    }
    const requestId = ++page.requestId;
    const wallet = walletKey();
    const context = { isCurrent:() => requestId === page.requestId && wallet === walletKey() };
    page.loading = true;
    page.loaded = false;
    try {
      await page.load?.(context);
      if (context.isCurrent()) {
        page.loaded = true;
        if (active(name)) page.activate?.();
      }
    } catch (cause) {
      if (context.isCurrent()) page.fail?.(cause);
    } finally {
      if (requestId === page.requestId) page.loading = false;
    }
  }

  window.Portal = { pages, register, load, invalidate, active, walletKey, readJSON, esc, number, money, percent, short, metric, loading, empty, walletGate, platformGate, error, header, aethonBadge };
  window.addEventListener('pagechange', event => {
    if (event.detail.previous !== event.detail.current) pages[event.detail.previous]?.deactivate?.();
  });
  document.addEventListener('visibilitychange', () => {
    const name = document.querySelector('.tab-panel.active')?.id?.replace('tab-', '');
    const page = pages[name];
    if (document.hidden) page?.deactivate?.();
    else if (page?.loaded) page.activate?.();
  });

  // ── 全局通用复制（兼容各手机端）──────────────────────────────────
  // 部分手机浏览器/WebView 没有 navigator.clipboard（或 HTTPS 手势校验不通过），
  // 只用 clipboard.writeText 会导致"复制不了推荐链接"。此函数三级降级：
  //   1) Clipboard API → 2) 隐藏 textarea + execCommand（iOS 用 Range 选区）→ 3) 返回 false 由调用方提示手动复制
  window.copyTextSmart = async (text) => {
    text = String(text ?? '');
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* 忽略,走降级 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      if (/ipad|iphone|iPod/i.test(navigator.userAgent) || (/Mac/.test(navigator.platform) && 'ontouchend' in document)) {
        // iOS: execCommand 只复制用户可见选区,需用 Range 选中
        const range = document.createRange();
        range.selectNodeContents(ta);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        ta.setSelectionRange(0, text.length);
      } else {
        ta.select();
      }
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      window.getSelection()?.removeAllRanges?.();
      if (ok) return true;
    } catch { /* 忽略,走最终失败 */ }
    return false;
  };
})();
