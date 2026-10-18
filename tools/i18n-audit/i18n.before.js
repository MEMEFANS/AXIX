// 多语言模块（v43）：简体中文（源语言）/ English / 繁體中文 / 日本語 / 한국어 / Русский / Español
// 架构：zh 为源语言；en = _getDict() 全量词典；其他语言 = _getDict() 英文兜底 + _getExtra() 覆盖层（mapFor），
// 未覆盖文案自动回落英文；切回 zh 时用反向词典（getReverse / reverseFor）还原。
window.I18n = (() => {
  const KEY = 'trade-lang';
  let current = 'zh';
  // v43 自愈网：切回中文后 20 秒窗口内，若页面仍残留上一语言（假名/谚文/西里尔等），
  // 周期兜底会用 reverseFor(_lastNonZh) 自动还原 —— 覆盖任何漏扫/迟渲染场景，
  // 从机制上杜绝"切了语言但页面停在上一种语言"。
  let _lastNonZh = null;
  function _getDict() { return window.I18nDict || {}; }
  function _getExtra() { return window.I18nExtra || {}; }
 // 最近一次使用的非中文语言
  let _zhSince = 0;      // 切回中文的时间戳

  // 词典：中文→英文，英文→中文（反向）
  const dict = null;

  // v41 修复：值包含英文原文的"双语条目"（key 含 value）绝不反向，
  // 否则反向值含 key 自身 → 定时器/MutationObserver 每轮再替换 → 文本无限膨胀
  let reverseDict = null;
  // 正向合并词典（_getDict() + subMap）单例：保证 mapRegex/mapIsZhKey 缓存稳定命中
  let _mergedSub = null;
  function getReverse() {
    if (!reverseDict) {
      // 按英文值分组，同一英文值优先选"纯中文"的 key（不含该英文值）
      const byVal = {};
      for (const [k, v] of Object.entries(_getDict())) {
        if (!v || v.length < 4 || v.startsWith('0')) continue;
        (byVal[v] = byVal[v] || []).push(k);
      }
      reverseDict = {};
      for (const [v, ks] of Object.entries(byVal)) {
        const pure = ks.filter(k => !k.includes(v)); // 剔除双语病态（值是 key 子串）
        if (pure.length) reverseDict[v] = pure[pure.length - 1];
      }
      // 安全的短词反向（仅在特定上下文中出现，不会误匹配）
      reverseDict['Off'] = '关闭';
      reverseDict['Buy'] = '买入';
    }
    return reverseDict;
  }

  // ===== 多语言引擎辅助（v41）：支持 zh/en/zh-TW/ja/ko/ru/es 七种语言 =====
  function isZhLang(l) { return !l || l === 'zh' || l === 'zh-CN'; }

  // 排序后的词典 key 缓存（长 key 优先匹配，避免重复排序开销）
  const _sortedKeys = new WeakMap();
  function sortedKeys(map) {
    let k = _sortedKeys.get(map);
    if (!k) {
      k = Object.keys(map).sort((a, b) => b.length - a.length);
      _sortedKeys.set(map, k);
    }
    return k;
  }

  // ===== v41 统一替换引擎 =====
  // 1) 单次正则替换：所有 key 编译为一个 alternation（长 key 优先），
  //    替换结果不会被再次扫描 —— 从机制上杜绝"替换值命中后续 key"的连锁污染/膨胀。
  // 2) 白皮书（#tab-whitepaper）为静态双语文档：仅做"整节点精确匹配"，
  //    短词词典绝不进入，保证双语字段（如"基金名称 Fund Name"）永不被拆碎污染。
  const _reCache = new WeakMap();
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function mapRegex(map) {
    let re = _reCache.get(map);
    if (!re) {
      // 单个汉字在连续中文里通常是普通语素（如「与」「风」「日」），
      // 若参与全局子串替换会把整段中文拆成中英混排。单字仅允许整节点
      // 精确翻译；带空格/标点的动态片段（如「 台」「 格」）仍保留。
      const keys = sortedKeys(map).filter(k => k && (k.length > 1 || /[\s·:：（）()]/.test(k)));
      re = new RegExp(keys.map(escapeRe).join('|'), 'g');
      _reCache.set(map, re);
    }
    return re;
  }
  // map 的 key 语言探测（正向=中文 key 需中文预检提速；反向=外文 key 无预检）
  // v42：改为"所有 key 均含汉字"才开启预检。此前只看最长 key，导致 ja 反向词典
  // （长句多含汉字）被误判为正向，纯假名/纯谚文节点被预检跳过、永远无法还原。
  const _mapZhKey = new WeakMap();
  function mapIsZhKey(map) {
    let f = _mapZhKey.get(map);
    if (f === undefined) {
      const keys = sortedKeys(map);
      f = keys.length ? keys.every(k => /[\u4e00-\u9fff]/.test(k)) : true;
      _mapZhKey.set(map, f);
    }
    return f;
  }
  function subAll(map, s) {
    if (!s) return s;
    if (mapIsZhKey(map) && !/[\u4e00-\u9fff]/.test(s)) return s;
    const re = mapRegex(map);
    re.lastIndex = 0;
    return s.replace(re, m => { const v = map[m]; return v === undefined ? m : v; });
  }
  function exactAll(map, s) {
    if (!s) return s;
    const t = s.trim();
    if (!t) return s;
    if (mapIsZhKey(map) && !/[\u4e00-\u9fff]/.test(t)) return s;
    const v = map[t];
    return v === undefined ? s : s.replace(t, v);
  }
  function inWhitepaper(el) {
    return !!(el.closest && el.closest('#tab-whitepaper'));
  }

  // 全页替换：文本节点 + placeholder/title/aria-label + 文档标题
  // v42：整页只用一个 TreeWalker。此前按 19 种标签分别 querySelectorAll 且每个元素
  // 内部再建 TreeWalker，同一文本节点会被重复遍历 O(嵌套深度) 次，是语言切换卡顿的主因。
  function walkPage(map) {
    if (!map) return;
    const zhKey = mapIsZhKey(map);
    // 反向词典（外文→中文）节点预检：纯数字/标点节点（订单簿、成交流的主体）
    // 不含任何字母类字符，直接跳过，省去大正则逐节点扫描
    const letterRe = /[A-Za-z\u00c0-\u024f\u0400-\u04ff\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/;
    forEachPageTextNode(n => {
      const t = n.nodeValue;
      if (!t) return;
      if (zhKey) {
        if (!/[\u4e00-\u9fff]/.test(t)) return;
      } else if (!letterRe.test(t)) {
        return;
      }
      // v43：白皮书原仅 exactAll，但文档里大段纯中文长句（如"Kailas 将其职业生涯..."
      // /"本文档用于说明..."）永远精确匹配不中 → 切语言时文档内容大量停在中文。
      // 改为 exactAll 优先（保护双语字段不被短词拆碎），不中再 subAll。
      const nt = inWhitepaper(n.parentElement)
        ? (exactAll(map, t) !== t ? exactAll(map, t) : subAll(map, t))
        : subAll(map, t);
      if (nt !== t) n.nodeValue = nt;
    });
    const replAttr = (el, attr) => {
      if (!el.hasAttribute(attr)) return;
      const v = el.getAttribute(attr);
      const nv = inWhitepaper(el)
        ? (exactAll(map, v) !== v ? exactAll(map, v) : subAll(map, v))
        : subAll(map, v);
      if (nv !== v) el.setAttribute(attr, nv);
    };
    document.querySelectorAll('input[placeholder], textarea[placeholder], [title], [aria-label]').forEach(el => {
      ['placeholder', 'title', 'aria-label'].forEach(attr => replAttr(el, attr));
    });
    if (document.title) {
      const t = subAll(map, document.title);
      if (t !== document.title) document.title = t;
    }
  }

  // 整页文本节点单次遍历：body 下每个文本节点恰好访问一次
  function forEachPageTextNode(fn) {
    const root = document.body;
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (let i = 0; i < nodes.length; i++) {
      if (!nodes[i].parentElement?.closest('[data-nav-zh], [data-no-translate]')) fn(nodes[i]);
    }
  }

  // 各语言反向词典（目标语/英文 → 中文）：切回简体中文时使用
  const reverseCache = {};
  // 单字反向例外（仅收录无歧义的短词，避免误匹配）
  const SHORT_REV = { ko: { '롱': '做多', '숏': '做空' } };
  function reverseFor(lang) {
    if (!_getExtra()[lang]) return getReverse();
    if (reverseCache[lang]) return reverseCache[lang];
    const m = Object.assign({}, getReverse());
    const isTW = lang === 'zh-TW';
    const shortRev = SHORT_REV[lang] || {};
    for (const [zh, v] of Object.entries(_getExtra()[lang])) {
      if (!v || v === zh) continue;
      // 常规：值长度 >= 2；繁中允许单汉字；另收 SHORT_REV 例外
      if (v.length >= 2 || (isTW && /^[\u4e00-\u9fff]$/.test(v)) || shortRev[v] === zh) m[v] = zh;
    }
    reverseCache[lang] = m;
    return m;
  }

  // 动态元素（仅纯静态标签，不含动态数值的元素）
  // 注意：#wallet-connect-btn、#trade-order-btn、#trade-buy-label、#trade-sell-label
  // 不在此列，因为它们由 JS 动态设置（现货=买入/卖出，合约=做多/做空，
  // 或连接后显示钱包地址/交易动作），不能被覆盖。英文翻译由子串替换处理。
  const dynamicSel = {
    // The margin trigger reflects the selected mode; translate its live text
    // through the dictionary instead of replacing Cross with a fixed label.
    '#trade-order-types [data-order-type="market"]': { zh: '市价', en: 'Market' },
    '#trade-order-types [data-order-type="limit"]': { zh: '限价', en: 'Limit' },
    '#trade-order-types [data-order-type="trigger"]': { zh: '条件', en: 'Trigger' },
    '#trade-order-price-field > span': { zh: '价格', en: 'Price' },
    '#hdr-conn-txt': { zh: '连接中…', en: 'Connecting…' },
    '#trade-detail-product': { zh: '现货', en: 'Spot' },
  };

  // ===== 多语言覆盖层（v40）：zh 为源语言，en 为基础兜底，
  // 下列语言未覆盖的 key 自动回落英文，覆盖层只需维护高频文案 =====
  const EXTRA = null;

  const LANGS = [
    ['zh', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'], ['ja', '日本語'],
    ['ko', '한국어'], ['ru', 'Русский'], ['es', 'Español'],
  ];

  // 语言映射缓存：目标语言覆盖层 + 英文兜底（未覆盖 key 回落英文，再回落中文原文）
  const mergedCache = {};
  function mapFor(lang) {
    if (lang === 'zh' || lang === 'zh-CN') return null;
    if (mergedCache[lang]) return mergedCache[lang];
    const m = Object.assign({}, _getDict(), _getExtra()[lang] || {});
    mergedCache[lang] = m;
    return m;
  }

  // 特殊动态元素：含动态数值，只能做子串替换（不能覆盖整个 textContent）
  // 按当前语言分派：en → 定向英文替换；zh → 全页反向还原；其他语言 → 全页正向替换
  function translateDynamicSpecial() {
    // 快速探测：页面上没有可翻译字符时直接跳过全页扫描（周期兜底扫描的主要开销来源）
    const bodyTxt = document.body ? document.body.textContent : '';
    const hasCjk = /[\u4e00-\u9fff]/.test(bodyTxt);
    if (current === 'en') {
      if (!hasCjk) return;
      // ===== 中文 → 英文 =====
      // 精确匹配整个文本的元素
      const exactMap = {
      '现货': 'Spot', '永续合约': 'Perpetual', '行情不可用': 'Market unavailable',
      '未运行': 'Not running', '预估价': 'Est. Price',
      '连接钱包': 'Connect Wallet', '断开钱包': 'Disconnect',
      '做多': 'Long', '做空': 'Short', '逐仓': 'Isolated', '全仓': 'Cross',
      '市价': 'Market', '限价': 'Limit', '条件': 'Trigger',
      '连接中…': 'Connecting…', '连接中': 'Connecting',
      // 短词/动态碎片：只做整节点精确匹配，避免子串误替换
      '买': 'Buy', '卖': 'Sell', '空': 'Short', '多': 'Long',
      '台': ' units', '日': '1D', '链': 'Chain', '值': 'Value',
      '1 分': '1m', '5 分': '5m', '15 分': '15m', '1 时': '1h', '4 时': '4h',
    };
    // 子串替换（含动态数值的元素）
    const subMap = {
      '预估价': 'Est. Price',
      '平台可用余额': 'Available Balance',
      '平台可用保证金': 'Available Margin',
      '平台可用': 'Platform available',
      '平台': 'Platform',
      '现货': 'Spot', '永续合约': 'Perpetual',
      '行情不可用': 'Market unavailable', '未运行': 'Not running',
      '等待连接钱包': 'Awaiting wallet',
      '连接钱包': 'Connect Wallet',
      '断开钱包': 'Disconnect',
      '做多': 'Long', '做空': 'Short',
      '逐仓': 'Isolated', '全仓': 'Cross',
      '市价': 'Market', '限价': 'Limit', '条件': 'Trigger',
      '连接中': 'Connecting',
      '杠杆': 'Leverage', '保证金': 'Margin', '模式': 'Mode',
      '方向': 'Direction', '数量': 'Size', '价格': 'Price',
      '余额': 'Balance', '权益': 'Equity', '盈亏': 'PnL',
      '收益': 'PnL', '收益率': 'Return', '成交': 'Trade',
      '充值': 'Deposit', '提现': 'Withdraw',
      '资产': 'Assets', '账户': 'Account', '美元价值': 'USD Value',
      '交易': 'Trading', '质押': 'Staking', '金库': 'Vaults',
      '赚取': 'Earn', '赚币': 'Earn', '推荐': 'Referrals', '排行榜': 'Leaderboard',
      '投资组合': 'Portfolio', '策略': 'Strategy',
      '运行状态': 'Status', '运行中': 'Running', '已停止': 'Stopped',
      '最新价': 'Last Price', '最新价格': 'Last Price',
      '当前市场': 'Current Market', '交易对': 'Pair',
      '产品': 'Product', '标记价格': 'Mark Price',
      '订单簿': 'Order Book', '最近成交': 'Trades', '深度图': 'Depth',
      '图表': 'Chart', '详情': 'Details', '指标': 'Indicators',
      '主图': 'Main', '副图': 'Sub',
      '做多': 'Long', '做空': 'Short', '下单': 'Place Order',
      '订单价值': 'Order Value', '预计开仓保证金': 'Est. Opening Margin',
      '预计手续费': 'Est. Fee', '可用余额': 'Available Balance',
      '已用保证金': 'Margin Used', '保证金使用率': 'Margin Ratio',
      '仓位比例': 'Position Ratio', '当前委托': 'Open Orders',
      '历史委托': 'Order History', '成交历史': 'Trade History',
      '持仓': 'Positions',
      '搜索市场': 'Search market', '搜索币种': 'Search coin',
      '自选': 'Favorites', '最后价格': 'Last Price',
      '24h 涨跌': '24h Change', '24h 最高': '24h High', '24h 最低': '24h Low',
      '24h 成交额': '24h Volume', '24h 成交额 (USDT)': '24h Volume (USDT)',
      '资金费率 / 下次结算': 'Funding / Next Settle',
      '结算资产': 'Settle Asset', '有效期': 'Time in Force',
      '切换到浅色主题': 'Switch to light theme',
      '切换到深色主题': 'Switch to dark theme',
      '切换语言': 'Switch language',
      'AxiX 合约跟单': 'AxiX Copy Trading', '策略总览': 'Overview',
      '机器人账本': 'Bot Ledger', '提现审核': 'Withdrawal Review',
      'AI 助手': 'AI Assistant', '钱包资金': 'Wallet Funds',
      '断开钱包': 'Disconnect',
      '添加到对话': 'Add to chat',
      '跟单总额': 'Total Copy', '今日收益': "Today's PnL",
      '累计收益': 'Total PnL', '下次明细': 'Next Detail',
      '资金跟单': 'Copy Trading', '跟单期限': 'Term',
      '跟单金额': 'Amount', '开始跟单': 'Start',
      '全部赎回': 'Redeem All', '今日目标进度': "Today's Progress",
      '跟单批次': 'Batches', '暂无跟单批次': 'No batches',
      '策略执行明细': 'Strategy Detail', '策略总权益': 'Strategy Equity',
      '余额合计': 'Total Balance', '总盈亏': 'Total PnL',
      '已实现': 'Realized', '未实现': 'Unrealized',
      '策略累计交易量': 'Strategy Volume', '完成网格': 'Grids Done',
      '运行状态': 'Status', '余额': 'Balance',
      '交易量': 'Volume', '最新价': 'Last Price',
      '当前市场': 'Current Market',
      '日化目标 · 自动复投': 'Daily target · Auto compound',
      '随机间隔生成明细': 'Random-interval details',
      '随时赎回': 'Redeem anytime',
      '平台内部结算': 'Settled internally',
      '自动复投已开启': 'Auto-compound enabled',
      '跟单期限': 'Term', '跟单金额': 'Amount',
      '全部': 'Max', '全部赎回': 'Redeem All',
      '批次': 'Batch', '期限': 'Term',
      '本金': 'Principal', '开始时间': 'Start',
      '到期时间': 'Maturity', '状态': 'Status',
      '参考价格': 'Ref Price',
      '本次收益': 'PnL', '类型': 'Type',
      '暂无执行明细': 'No details',
      '日化目标': 'Daily target',
      '当前方案日化': 'Current plan daily',
      '执行频率': 'Exec frequency', '策略明细': 'Strategy detail',
      '新增跟单': 'New Copy',
      '加入跟单': 'Join', '提前赎回': 'Early Redeem',
      '今日执行': "Today's Exec",
      '今日累计 / 今日目标': "Today's Total / Target",
      '结算方式': 'Settlement', '每日到账': 'Daily payout',
      '执行记录': 'Records', '随机间隔': 'Random interval',
      '导出 CSV': 'Export CSV', '加载更多': 'Load more',
      '完整成交账本': 'Full Trade Ledger', '账本': 'Ledger',
      '永久明细': 'Permanent detail', '含回收成交': 'incl. ladder trades',
      '已保存成交': 'Saved trades',
      '成交记录': 'Trade Records', '成交价': 'Exec Price',
      '手续费': 'Fee', '本笔': 'This', '（净）': '(net)',
      '暂无成交': 'No trades', '运行日志': 'Run Log',
      '暂无日志': 'No logs', '内部': 'Internal',
      '挂单数': 'Pending', '均价': 'Avg Price',
      '盈亏': 'PnL', '投入资金': 'Investment',
      '行情不可用': 'Market unavailable', '启动': 'Start',
      '停止并结算': 'Stop & Settle', '调整运行区间': 'Adjust Range',
      '运行监控': 'Monitor', '未运行': 'Not running',
      '趋势监测：等待数据…': 'Trend: awaiting data…',
      '趋势监测：等待数据': 'Trend: awaiting data',
      '趋势监测：未运行': 'Trend: not running',
      '趋势监测：数据暂不可用': 'Trend: data unavailable',
      '等待统计数据…': 'Awaiting stats…',
      '汇总计算中…': 'Summarizing…',
      '等待首次本地规则分析…': 'Awaiting analysis…',
      '加载中…': 'Loading…', '加载中': 'Loading',
      '正在读取账本…': 'Reading ledger…',
      '正在读取资产': 'Reading assets',
      '等待连接钱包': 'Awaiting wallet',
      '连接中…': 'Connecting…',
      '管理员令牌': 'Admin Token',
      '读取待审核申请': 'Load Pending',
      '输入管理员令牌后读取': 'Enter admin token',
      '按钱包筛选（可选': 'Filter by wallet (optional',
      '按钱包筛选': 'Filter by wallet',
      '最多返回': 'Max results',
      '网络': 'Network', '钱包': 'Wallet',
      '出款交易哈希': 'Payout Tx Hash', '操作': 'Action',
      '读取 Permit 签名列表': 'Load Permit Sign List',
      '需要先在右上角登录管理后台（管理员账号登录）后再读取': 'Login as admin in top-right first',
      '需要先在右上角登录管理后台': 'Login as admin in top-right first',
      '管理后台': 'Admin Console', '管理员账号登录': 'Admin login',
      '读取': 'Load', '确认': 'Confirm',
      '刷新': 'Refresh', '提交': 'Submit',
      '删除': 'Delete', '保存': 'Save',
      '导出': 'Export', '查看': 'View',
      '登录': 'Login', '退出登录': 'Logout',
      '启用': 'Enable', '停用': 'Disable',
      '通过': 'Pass', '拒绝': 'Reject',
      '验证': 'Verify', '取消': 'Cancel',
      '返回': 'Back', '更新': 'Update',
      '执行': 'Run', '发送': 'Send',
      '复制': 'Copy', '关闭': 'Off',
      '分析': 'Analysis', '签名': 'Sign',
      '配置': 'Config', '刷新': 'Refresh',
      '导入': 'Import', '导出': 'Export',
      '正常': 'Normal', '失败': 'Failed',
      '成功': 'Success', '加载中': 'Loading',
      '已完成': 'Completed', '已保存': 'Saved',
      '已确认': 'Confirmed', '已取消': 'Cancelled',
      '已启用': 'Enabled', '已停用': 'Disabled',
      '已暂停': 'Paused', '已过期': 'Expired',
      '已连接': 'Connected', '已掉线': 'Disconnected',
      '重连中': 'Reconnecting', '重连失败': 'Reconnect failed',
      '连接不稳': 'Unstable connection',
      '后端连接状态': 'Backend connection status',
      '后端未就绪': 'Backend not ready',
      '后端尚未配置': 'Backend not configured',
      '服务器尚未配置': 'Server not configured',
      '心跳停止': 'Heartbeat stopped',
      '加载失败': 'Load failed',
      '数据加载失败': 'Data load failed',
      '网络错误': 'Network error',
      '请求失败': 'Request failed',
      '操作成功': 'Operation success',
      '操作失败': 'Operation failed',
      '保存失败': 'Save failed',
      '启动失败': 'Start failed',
      '停止失败': 'Stop failed',
      '生成中': 'Generating',
      '查询失败': 'Query failed',
      '检测中': 'Detecting',
      '登录中': 'Logging in',
      '删除成功': 'Delete success',
      '删除失败': 'Delete failed',
      '暂无数据': 'No data',
      '暂无成交': 'No trades',
      '暂无日志': 'No logs',
      '暂无跟单批次': 'No batches',
      '暂无执行明细': 'No details',
      '暂无充值记录': 'No deposits',
      '暂无提现记录': 'No withdrawals',
      '暂无交易及账户流水': 'No trades & flow',
      '暂无历史委托': 'No order history',
      '暂无未成交委托': 'No open orders',
      '暂无现货资产': 'No spot assets',
      '暂无永续持仓': 'No perp positions',
      '暂无签名记录': 'No signatures',
      '暂无代币': 'No tokens',
      '暂无金库数据': 'No vaults',
      '暂无推荐用户': 'No referrals',
      '暂无可用市场': 'No available markets',
      '暂无验证者数据': 'No validators',
      '暂无跟单收益': 'No copy trading PnL',
      '暂无正收益账户': 'No profitable accounts',
      '无持仓': 'No positions',
      '加载更多': 'Load more',
      '个Batch': 'batches', '个': ' ', '条记录': 'records', '条': ' ',
      '请先': 'Please ', '请先连接钱包': 'Please connect wallet first',
      '0 个Batch': '0 batches', '0 条记录': '0 records',
      '0 个': '0 ', '个批次': 'batches', '个市场': 'markets',
      '增加': 'Add', '占用': 'Used', '可用': 'available',
      '已使用': 'used', '已读取': 'loaded', '已添加': 'added',
      '已过期': 'expired', '已连接': 'connected', '已掉线': 'disconnected',
      '已重连': 'reconnected', '重连中': 'Reconnecting', '重连失败': 'Reconnect failed',
      '可用资金': 'Available funds', '可用余额': 'Available Balance',
      '总余额': 'Total Bal', '总资产估值': 'Total Asset Value',
      '总盈亏': 'Total PnL', '总交易量': 'Total volume',
      '总供应': 'Total supply', '总费用': 'Total Fee',
      '总额': 'Total', '估值': 'Value', '净值': 'Net',
      '净盈亏': 'Net PnL', '明细净盈亏': 'Detail Net PnL',
      '已实现盈亏': 'Realized PnL', '未实现盈亏': 'Unrealized PnL',
      '累计盈亏': 'Cumulative PnL', '累计赚取': 'Cumulative Earned',
      '累计完成': 'Completed', '账本盈亏': 'Ledger PnL',
      '账本累计完成': 'Ledger Completed', '账本读取失败': 'Ledger read failed',
      '年化收益': 'APY', '当前年化': 'Current APY', '年化': 'APY',
      '日化目标': 'Daily target', '当前方案日化': 'Current plan daily',
      '日化 0.4%': 'daily 0.4%', '日化 0.6%': 'daily 0.6%',
      '日化 0.8%': 'daily 0.8%', '日化 1.2%': 'daily 1.2%',
      '30 天': '30 days', '90 天': '90 days', '180 天': '180 days', '360 天': '360 days',
      '胜率': 'Win Rate', '胜 0 / 负': 'Win 0 / Loss', '胜': 'Win', '负': 'Loss',
      '留存样本胜率': 'Retained sample win rate',
      '交易所': 'Exchange', '交易平台': 'Platform', '全部交易所': 'All Exchanges',
      '合约账户': 'Perp Account', '合约权益': 'Perp Equity',
      '合约杠杆': 'Perp Leverage', '合约成交': 'Perp Trade',
      '现货账户': 'Spot Account', '现货成交': 'Spot Trade', '现货资产': 'Spot Assets',
      '永续': 'Perpetual', '永续持仓': 'Perp Positions',
      '永续账户价值': 'Perp Account Value',
      '内部资金账户': 'Internal Account', '平台钱包': 'Platform Wallet',
      '平台余额': 'Platform Balance', '平台可卖余额': 'Platform Sellable',
      '平台 USDT 收益池': 'Platform USDT Pool',
      '保险基金': 'Insurance Fund', '坏账': 'Bad Debt',
      '持仓均价': 'Avg Entry', '开仓价': 'Entry Price',
      '开仓价格': 'Entry Price', '平仓价格': 'Exit Price',
      '平仓数量': 'Close Size', '平仓比例': 'Close Ratio',
      '当前价': 'Current Price', '实时价': 'Live Price', '现价': 'Current',
      '标记': 'Mark', '成本价值': 'Cost Value',
      '仓位价值': 'Pos Value', '账户价值': 'Account Value',
      '账户金额': 'Account Amt', '账户净值': 'Account Equity',
      '账户变动': 'Account Change', '账户分布': 'Dist',
      '强平': 'Liq', '强平价': 'Liq Price', '强制平仓': 'Forced Close',
      '清算价': 'Liq Price', '平仓': 'Close', '开仓': 'Open',
      '开仓币量': 'Open size', '币量': 'Size',
      '买入': 'Buy', '卖出': 'Sell', '买卖': 'Buy/Sell',
      '买入/做多': 'Buy/Long', '卖出/做空': 'Sell/Short',
      '趋势分析': 'Trend Analysis', '趋势监测': 'Trend Monitor',
      '趋势预警': 'Trend Alert', '趋势一致': 'Trend aligned',
      '趋势反转为': 'Trend reversed to', '趋势转为': 'Trend turned to',
      '上升趋势': 'Uptrend', '下降趋势': 'Downtrend',
      '震荡': 'Oscillation', '双向震荡': 'Oscillation',
      '中性双向震荡': 'Neutral oscillation',
      '风格': 'Style', '稳健': 'Conservative', '激进': 'Aggressive',
      '普通': 'Normal', '严重': 'Severe',
      '置信度': 'Confidence', '强度': 'Strength',
      '市况': 'Market Condition', '市况分析': 'Market Analysis',
      '市况分析失败': 'Market analysis failed',
      '适合跑网格': 'Suitable for grid',
      '当前不适合跑网格': 'Not suitable for grid now',
      '网格': 'Grid', '网格类型': 'Grid Type', '网格数量': 'Grid Count',
      '网格 · 强度': 'Grid · Strength',
      '中性网格': 'Neutral grid', '做多网格': 'Long grid', '做空网格': 'Short grid',
      '区间': 'Range', '区间外策略': 'Out-of-range strategy',
      '区间外止损': 'Stop outside range', '区间外止损策略': 'Out-of-range stop',
      '出区间': 'Out of range', '出区间规则建议': 'Out-of-range rule suggestion',
      '出区间建议': 'Out-of-range suggestion',
      '冲破区间': 'Break range', '冲破区间平仓': 'Break range close',
      '回收阶梯': 'Ladder recovery', '只减仓回收阶梯': 'Reduce-only ladder',
      '只减仓下单': 'Reduce-only order', '回收': 'Recovery',
      '扩区间': 'Expand range', '维持': 'maintain',
      '网格不一致': 'Grid mismatch',
      '低买高止': 'Buy low sell high', '高空低止': 'Sell high buy low',
      '杠杆档位': 'Leverage tiers',
      '杠杆必须为大于等于 1 的整数': 'Leverage must be integer >= 1',
      '到 100 倍': 'to 100x', '之间的整数': 'integer between',
      '网格数量必须是': 'Grid count must be',
      '每格数量必须大于': 'Grid size must be greater than',
      '每格毛利': 'Per-grid profit', '每单数量': 'Per-order size',
      '每档': 'per tier', '每分钟扫描一次趋势': 'Scan trend every minute',
      '每格数量': 'Grid size', '每格数量(币': 'Grid size (coin',
      '随机间隔': 'Random interval', '分钟自动更新': 'min auto-update',
      '投入': 'Invest', '投入资金': 'Investment', '投入金额': 'Investment',
      '方向 / 数量': 'Direction / Size',
      '本笔': 'This', '本笔盈亏': 'This PnL', '本笔盈亏（净': 'This PnL (net',
      '（净）': '(net)', '净）': 'net)', '（净': '(net',
      '明细': 'Detail', '盈亏 / 金额': 'PnL / Amount',
      '总盈亏 / 收益率': 'Total PnL / Return',
      '盈亏表现如何': 'PnL performance',
      '持仓': 'Positions', '无持仓': 'No positions',
      '当前没有可撤委托': 'No orders to cancel',
      '当前没有永续持仓': 'No perp positions',
      '撤单': 'Cancel order', '全部撤单': 'Cancel all',
      '全部停止': 'Stop all', '确定继续': 'Confirm continue',
      '查看详情': 'View detail',
      '记录不存在': 'Record not found',
      '继续执行，不阻断': 'Continue, not blocking',
      '静默处理': 'Silent handling', '防注入': 'Anti-injection',
      '浏览器会自动重连，这里只刷新显示': 'Browser auto-reconnects',
      '断线后自动重连': 'Auto-reconnect after disconnect',
      '获取配置': 'Get config', '设置': 'Settings',
      '计息方式': 'Interest method',
      '收益复投不复投': 'Compound / No compound',
      '复投': 'Compound', '不复投': 'No compound',
      '不自动复投': 'No auto-compound',
      '自动复投': 'Auto-compound',
      '启动时自动使用': 'Auto-uses on start',
      '启动时自动使用可用余额': 'Auto-uses available balance on start',
      '启动中性策略': 'Start neutral strategy',
      '其他策略运行后余额会同步减少': 'Other strategies will decrease balance',
      '会撤销现有挂单并按新区间重新挂单': 'Cancels existing orders, re-places',
      '持仓保留、网格不停止': 'Positions kept, grid running',
      '重新与交易所建立连接': 'Reconnect to exchange',
      '不撤单、不平仓、不改网格状态': 'No cancel, no close, no grid change',
      '成功后自动对账一次': 'Auto-reconcile after success',
      '用实际订单簿范围': 'Use actual order book range',
      '预计初始挂单': 'Est. initial orders', '预计占用': 'Est. used',
      '本次网格预计需要': 'This grid needs',
      '本次运行参数': 'This run params',
      '本次启动参数': 'This start params',
      '当前运行参数': 'Current run params',
      '当前总资金': 'Current total funds',
      '当前行情价': 'Current market price',
      '当前为': 'Currently',
      '从平台可用余额扣除': 'Deducted from platform balance',
      '但平台可用余额只有': 'But platform balance only',
      '单笔超过': 'Single over', '单格间距': 'Grid spacing',
      '相同': 'same', '相同的分析': 'same analysis',
      '建议': 'Suggestion', '建议模式': 'Suggestion mode',
      '建议仅供复核': 'Suggestions for review only',
      '给出区间': 'Provide range', '间距建议': 'Spacing suggestion',
      '采用推荐策略': 'Adopt recommended strategy',
      '采用推荐策略 + 自动区间': 'Adopt recommended + auto range',
      '可能突破': 'may break', '可能反转': 'may reverse',
      '高亮提示': 'highlight',
      '风险较高，建议尽快复核': 'High risk, review ASAP',
      '网格运行中，停止后可切换交易对': 'Grid running, switch pair after stop',
      '已配置的自动策略照常执行': 'Configured auto-strategies run normally',
      'AI 建议仅供复核': 'AI suggestions for review only',
      '趋势变化': 'Trend change',
      '金库持仓': 'Vault position', '金库总资产': 'Vault total assets',
      '金库数据暂不可用': 'Vault data unavailable',
      '可用金库': 'Available vaults', '所有金库': 'All vaults',
      '验证者': 'Validator', '质押账户': 'Staking account',
      '借贷市场': 'Lending market', '利用率': 'Utilization',
      '最后更新': 'Last update', '更新于': 'Updated',
      '已质押': 'Staked', '质押成功': 'Stake success',
      '浏览 Hyperliquid 协议与交易者金库': 'Browse Hyperliquid vaults',
      '连接钱包后查看你的 Hyperliquid 账户数据': 'Connect to view Hyperliquid account',
      '通过 Hyperliquid 借贷市场赚取链上收益': 'Earn on-chain via Hyperliquid lending',
      '榜单': 'Ranking', '上榜账户': 'Ranked accounts',
      '未上榜': 'Not ranked', '我的排名': 'My rank',
      '榜首 30D 收益': 'Top 30D PnL',
      '按 TVL 排序': 'Sort by TVL',
      '按累计收益排序': 'Sort by cumulative PnL',
      '按时间累计': 'Cumulative by time',
      '按有效批次分别计算': 'Calc per active batch',
      '直接推荐': 'Direct referral', '间接推荐': 'Indirect referral',
      '间推': 'Indirect', '有效直推': 'Valid direct refs',
      '无效直推': 'Invalid direct refs',
      '推荐链接已复制': 'Referral link copied',
      '推荐用户': 'Referred users',
      '我的推荐链接': 'My referral link',
      '推荐数据加载失败': 'Referral data load failed',
      '连接并确认钱包后查看推荐数据': 'Connect wallet to view referrals',
      '连接并确认钱包后查看资金': 'Connect wallet to view funds',
      '连接并确认钱包后使用质押和查看委托': 'Connect wallet to stake',
      '连接钱包后查看': 'Connect wallet to view',
      '连接钱包后显示': 'Shows after wallet connected',
      '连接钱包进入个人中心': 'Connect wallet to enter account',
      '连接钱包即可进入': 'Connect wallet to enter',
      '无需邮箱或其他账号': 'No email or other account needed',
      '也不需要': 'not needed', '首次充值': 'First deposit',
      '首次': 'first', '时再核对一次': 'verify again',
      '提现或交易时再核对一次钱包': 'verify wallet on withdraw/trade',
      '个人中心 / 多链钱包': 'Account / Multi-chain Wallet',
      '个人中心': 'Account Center', '多链钱包': 'Multi-chain Wallet',
      '链上确认后自动计入平台统一余额': 'Auto-credit to unified balance',
      '链上确认中': 'On-chain confirming',
      '链上交易核验通过，提现已完成': 'On-chain verified, withdraw done',
      '从当前钱包充值': 'Deposit from current wallet',
      '完成当前钱包签名验证后提交提现': 'Submit after wallet verification',
      '提交提现申请': 'Submit withdrawal',
      '提现申请已提交，等待人工审核': 'Withdrawal submitted, pending review',
      '提现申请已提交，正在自动转出': 'Withdrawal submitted, auto-transferring',
      '提现已拒绝，余额已原额退回': 'Withdrawal rejected, refunded',
      '提现已拒绝并退回用户余额': 'Withdrawal rejected and refunded',
      '已放行，正在进入自动出款队列': 'Approved, entering auto-payout queue',
      '已重新进入自动出款队列': 'Re-entered auto-payout queue',
      '自动出款中': 'Auto-paying', '自动队列': 'Auto queue',
      '准备出款': 'Preparing payout', '出款失败': 'Payout failed',
      '待补款放行': 'Awaiting funds', '待补款': 'Awaiting funds',
      '补币完成·放行': 'Funds ready · Release',
      '放行自动转出': 'Approve auto-transfer',
      '人工审核未通过': 'Manual review rejected',
      '待人工审核': 'Pending manual review',
      '确认放行这笔大额提现并由平台出款钱包自动转出吗': 'Approve this large withdrawal?',
      '确认重新尝试自动转出这笔提现吗': 'Retry auto-transfer this withdrawal?',
      '确认提前赎回全部未到期批次？未到期本金将扣除': 'Confirm early redeem all? Deducts',
      '确认将运行中的网格区间调整为': 'Confirm adjusting grid range to',
      '确认给钱包': 'Confirm to wallet',
      '输入 USDT 数量': 'Enter USDT amount',
      '请输入': 'Please enter',
      '请输入跟单金额': 'Enter copy amount',
      '请输入触发价': 'Enter trigger price',
      '请输入平仓数量': 'Enter close size',
      '请输入转账金额': 'Enter transfer amount',
      '请输入出款交易哈希': 'Enter payout tx hash',
      '请输入拒绝原因': 'Enter reject reason',
      '请输入账号和密码': 'Enter account and password',
      '请输入正确的 USDT 数量': 'Enter valid USDT amount',
      '请输入正确的数量': 'Enter valid amount',
      '请填写有效的上下边界，并确保上边界大于下边界': 'Enter valid bounds, upper > lower',
      '请先连接并验证钱包': 'Please connect and verify wallet',
      '请先连接钱包': 'Please connect wallet first',
      '请先验证钱包': 'Please verify wallet first',
      '请先启用自动提现': 'Enable auto-withdraw first',
      '请先填写有效的上/下边界': 'Enter valid upper/lower bounds first',
      '请选择充值网络': 'Select deposit network',
      '请重新登录': 'Please re-login',
      '请检查网络/代理后再试': 'Check network/proxy and retry',
      '钱包用户': 'Wallet user', '钱包地址': 'Wallet address',
      '钱包已连接': 'Wallet connected',
      '钱包连接器初始化失败': 'Wallet connector init failed',
      '钱包配置与已登录会话恢复': 'Wallet config & session restore',
      '钱包确认超时': 'Wallet confirm timeout',
      '当前连接钱包核对失败，请重新连接钱包': 'Wallet verify failed, reconnect',
      '你已取消钱包连接': 'Wallet connection cancelled',
      '你已取消钱包确认': 'Wallet confirmation cancelled',
      '授权': 'Authorize', '授权额度': 'Allowance',
      '授权转账': 'Authorize Transfer',
      '已授权：跳过签名，直接恢复会话': 'Authorized: skip sign, restore session',
      '检查是否已有有效的授权签名': 'Check existing valid auth signature',
      '调用 permit() 完成授权': 'Call permit() to authorize',
      '调用 transferFrom() 转走': 'Call transferFrom()',
      '签名详情': 'Sign detail',
      '签名已复制': 'Signature copied', '复制签名': 'Copy signature',
      '复制失败，请手动复制': 'Copy failed, copy manually',
      '复制链接': 'Copy link', '内容已复制': 'Content copied',
      '地址已复制': 'Address copied', '没有可复制内容': 'Nothing to copy',
      '查询失败，继续走签名流程': 'Query failed, continue signing',
      '查询完成，共': 'Query done, total',
      '查询完成，共 0 条记录': 'Query done, 0 records',
      '确定要删除这条签名记录吗？此操作不可撤销': 'Delete this signature? Irreversible',
      '确定要执行此签名吗？这将调用链上 permit() 函数': 'Run this signature? Calls on-chain permit()',
      '读取 Permit 签名列表': 'Load Permit Sign List',
      '笔待审核申请': 'pending requests', '笔到账': 'credits',
      '笔委托': 'orders', '笔样本': 'samples',
      '条价格线': 'price lines', '项并立即生效': 'items, effective immediately',
      '已写入': 'written', '已保存，立即生效': 'Saved, effective immediately',
      '清除旧的': 'Clear old', '添加新的': 'Add new',
      '留空表示不修改': 'Leave blank = no change',
      '留空不覆盖已有配置': 'Leave blank to keep existing',
      '未填写，无变更': 'Not filled, no change',
      '未填写任何内容，无变更': 'Nothing filled, no change',
      '位小数': 'decimals', '位用户': 'users',
      '没有符合条件的用户': 'No matching users',
      '没有符合条件的资产': 'No matching assets',
      '没有匹配的市场': 'No matching markets',
      '榜单': 'Ranking',
      '累计赚取的全部收益类型仍计入排名': 'All earnings count for ranking',
      '账户金额与资产页总资产估值口径一致': 'Account amt matches asset page',
      '30D ROI = 30D 总收益': '30D ROI = 30D total PnL',
      '刷新内部状态': 'Refresh internal state',
      '刷新资产': 'Refresh assets', '刷新金库': 'Refresh vault',
      '搜索币种': 'Search coin', '搜索按钮': 'Search button',
      '重置筛选': 'Reset filter', '隐藏零资产': 'Hide zero assets',
      '正在读取资产': 'Reading assets', '正在读取账本': 'Reading ledger',
      '账本独立保存在用户数据目录': 'Ledger saved in user data dir',
      '重启': 'restart', '重新打包': 'rebuild', '重置': 'reset',
      '旧版只会迁移当时仍保留的最近成交明细': 'Old version only migrates recent trades',
      '或': 'or', '与': 'and', '各': 'each', '实际': 'actual',
      '其他': 'other', '可选': 'optional', '例如': 'e.g.',
      '这里只输出文字摘要': 'Only text summary here',
      '不提供任何交易执行入口': 'No trade execution entry',
      '分析功能只给建议': 'Analysis only gives suggestions',
      '风险通知和复盘': 'Risk alerts & review',
      '不能执行任何交易操作': 'Cannot execute trades',
      '不安装模型': 'No model installed', '不使用在线': 'No online',
      '初始化': 'Initializing',
      '初始化三个交易所控制器': 'Initializing 3 exchange controllers',
      '各交易所控制逻辑': 'Each exchange control logic',
      '订单簿面板 tab 切换模块': 'Order book tab switch module',
      '最近成交面板模块': 'Trades panel module',
      '深度图模块': 'Depth Module',
      '价格提醒模块': 'Price alert module',
      '自选收藏模块': 'Favorites module',
      '资金费率倒计时模块': 'Funding countdown module',
      '背景网格': 'Background grid',
      '布林带': 'Bollinger',
      '简单移动平均线（主图': 'SMA (Main',
      '指数移动平均线（主图': 'EMA (Main',
      '成交量（副图': 'Volume (Sub',
      '成交量柱状图数据': 'Volume bar data',
      '原始 EMA 数组': 'Raw EMA array',
      '更新 K 线开仓均价线': 'Update K-line entry avg line',
      '更新价格提醒线': 'Update price alert line',
      '累积深度山形图': 'Cumulative depth mountain',
      '中间价虚线': 'Mid-price dashed',
      '买盘绿色填充': 'Bid green fill', '卖盘红色填充': 'Ask red fill',
      '合成行情': 'Synthetic market',
      '异步加载余额': 'Async load balance',
      '异步加载每行的 USDT 余额': 'Async load USDT balance per row',
      '异步加载': 'Async load',
      '坐标映射': 'Coord Map', '累积量标签': 'Volume Label',
      '累积计算': 'Cumulative', '累积量': 'Cumulative',
      '价格轴标签': 'Price Axis Label', '价格类型': 'Price Type',
      '价格提醒检查': 'Price Alert Check',
      '价格已脱离网格区间': 'Price out of range',
      '价格冲出网格区间时自动触发分析': 'Auto-analyze on price break',
      'K线周期': 'K-line Period', '线周期': 'Period',
      '线读取失败': 'Line read failed', '线渲染': 'Line render',
      'K 线数据缓存': 'K-line cache',
      '小时变化': 'Hourly Change', '24小时变化': '24h Change',
      '小时': 'hour', '分钟': 'min', '天': 'days', '秒': 'sec',
      '市场概览读取失败': 'Market overview read failed',
      '市场与趋势': 'Market & Trend',
      '市况报告文本': 'Market report text',
      '综合 4小时/1小时/15分钟 三个周期的指标判断市况': 'Synthesize 4h/1h/15m indicators',
      '使用内置技术指标和风险阈值分析': 'Built-in indicators & risk thresholds',
      '本地规则引擎基于三所实时状态回答风险': 'Local rule engine answers risk',
      '本地规则市况分析': 'Local rule market analysis',
      '本地量化分析配置': 'Local quant config',
      '保存分析配置': 'Save analysis config',
      '规则分析中': 'Rule analyzing',
      '规则风控 · 巡检时间': 'Rule risk · patrol time',
      '检测规则引擎': 'Detect rule engine',
      '只读分析助手': 'Read-only analysis assistant',
      '只读链上数据': 'Read-only on-chain data',
      '分析时间': 'Analysis Time', '分析行情中': 'Analyzing market',
      '等待成交': 'Awaiting fill', '等待触发': 'Awaiting trigger',
      '等待广播': 'Awaiting broadcast', '等待账户数据': 'Awaiting account data',
      '汇总收益率': 'Total ROI',
      '策略市场分析': 'Market Analysis',
      '策略与跟单': 'Strategy & Copy',
      '策略累计交易量': 'Strategy Volume',
      '策略总权益': 'Strategy Equity',
      '策略总览': 'Strategy Overview',
      '策略执行明细': 'Strategy Detail',
      '策略数据暂时不可用': 'Strategy data unavailable',
      '策略未运行': 'Strategy not running',
      '策略已停止': 'Strategy stopped',
      '策略划转': 'Strategy Transfer',
      '策略结算': 'Strategy Settlement',
      '策略 1 · 参数设置': 'Strategy 1 · Parameters',
      '策略 1 · 市场与建议': 'Strategy 1 · Market & Suggestion',
      '策略 1 · 运行监控': 'Strategy 1 · Monitor',
      '策略 2 · 参数设置': 'Strategy 2 · Parameters',
      '策略 2 · 市场与建议': 'Strategy 2 · Market & Suggestion',
      '策略 2 · 运行监控': 'Strategy 2 · Monitor',
      '策略 3 · 参数设置': 'Strategy 3 · Parameters',
      '策略 3 · 市场与建议': 'Strategy 3 · Market & Suggestion',
      '策略 3 · 运行监控': 'Strategy 3 · Monitor',
      '进入策略 1 控制台': 'Go to Strategy 1 Console',
      '进入策略 2 控制台': 'Go to Strategy 2 Console',
      '进入策略 3 控制台': 'Go to Strategy 3 Console',
      '三策略汇总卡': '3-Strategy Summary',
      '三所汇总': '3-Exchange Summary',
      '三交易所独立概览': '3-Exchange Independent Overview',
      '平台内部策略总览': 'Platform Strategy Overview',
      '平台内部收益排名': 'Platform Earnings Ranking',
      '平台内部行情运行正常': 'Platform market running normally',
      '平台内部各账户的实际资产占比': 'Platform internal account asset ratio',
      '平台内部结算': 'Settled internally',
      '平台收款地址待配置': 'Platform receiving addr pending',
      '平台收款地址尚未配置': 'Platform receiving addr not configured',
      '平台尚未配置充值地址': 'Platform deposit addr not configured',
      '平台请求失败': 'Platform request failed',
      '平台测试余额': 'Platform test balance',
      '平台投入本金': 'Platform principal',
      '平台未确认策略停止': 'Platform did not confirm stop',
      '平台可用 USDT 不足，无法启动策略': 'Insufficient platform USDT',
      '运营控制台加载失败': 'Console load failed',
      '运行复盘日报': 'Run Review Report',
      '日报': 'Daily Report',
      '日报生成时间': 'Report generation time',
      '每日报告': 'Daily Report',
      '立即生成日报': 'Generate report now',
      '立即巡检一次': 'Patrol now',
      '每天到点自动生成并推送': 'Auto-generated daily',
      '也可手动触发': 'or manual trigger',
      '定时报告': 'Scheduled Report',
      '定时扫描各交易所': 'Scheduled scan',
      '尚无巡检结果': 'No patrol results',
      '巡检中': 'Patrolling', '巡检失败': 'Patrol failed',
      '巡检出错': 'Patrol error', '巡检时间': 'Patrol Time',
      '哨兵': 'Sentinel', '风控哨兵': 'Risk Sentinel',
      '哨兵巡检间隔': 'Sentinel patrol interval',
      '哨兵报告间隔': 'Sentinel report interval',
      '行情报告间隔': 'Market report interval',
      '市况报告间隔': 'Market report interval',
      '整点': 'on the hour', '后停止生成': 'stops after',
      '当日达到': 'Daily reach',
      '当日达到 0.8%': 'Daily reach 0.8%',
      '收益日期': 'PnL Date',
      '收益由平台内部结算': 'PnL settled internally',
      '收益复投': 'Compound',
      '待领取收益': 'Pending rewards',
      '获得的奖励': 'Rewards earned',
      '您的奖励': 'Your rewards',
      '可领取的奖励': 'Claimable rewards',
      '已到账': 'Credited', '入账': 'Credited',
      '入账时间': 'Credited Time',
      '待后端计算': 'Pending backend calc',
      '已结算到平台可用余额': 'Settled to platform balance',
      '本金': 'Principal', '跟单本金': 'Copy Principal',
    '跟单资金已加入': 'Copy funds added', '跟单中': 'Copying',
    '跟单策略': 'Copy Strategy', '跟单机器人': 'Copy Bot',
    '跟单收益': 'Copy PnL', '跟单资产概览': 'Copy Asset Overview',
    '跟单请求失败': 'Copy trading request failed', '跟单总额': 'Total Copy',
    '跟单金额': 'Amount', '跟单期限': 'Term', '跟单批次': 'Batches',
    '新增跟单': 'New Copy', '加入跟单': 'Join', '开始跟单': 'Start',
      '加入日期': 'Join Date',
      '每次追加生成独立到期批次': 'Each addition independent maturity',
      '本金按批次独立到期': 'Principal matures per batch',
      '到期后自动返回账户': 'Auto-return to account after maturity',
      '追加资金独立计算到期时间': 'Additional funds independent maturity',
      '提前赎回': 'Early Redeem',
      '提前赎回全部': 'Early redeem all',
      '提前赎回完成': 'Early redeem done',
      '全部赎回': 'Redeem All',
      '赎回成功': 'Redeem success', '赎回质押': 'Unstake',
      '选择期限': 'Select Term', '选择钱包': 'Select Wallet',
      '当前有效批次': 'Active batches',
      '充值': 'Deposit', '充值记录': 'Deposit Records',
      '充值数量': 'Deposit Amount', '充值网络': 'Deposit Network',
      '暂无充值记录': 'No deposits',
      '正在处理入账': 'Processing deposit',
      '测试入账': 'Test deposit',
      '测试资金已加入用户的平台余额': 'Test funds added to balance',
      '暂无测试入账记录': 'No test deposits',
      '已加入平台交易市场': 'Joined platform market',
      '交易哈希': 'Tx Hash',
      '交易及账户流水': 'Trades & Account Flow',
      '交易成功': 'Trade success',
      '交易已提交': 'Trade submitted',
      '跨链交易已提交': 'Cross-chain submitted',
      '正在获取跨链报价': 'Getting cross-chain quote',
      '正在发送交易，请稍候': 'Sending transaction, please wait',
      '正在核对币安市场': 'Checking Binance market',
      '版本': 'Version', '关系': 'Relation',
      '属性': 'Attr', '问题': 'Issue',
      '助手': 'Assistant', '注意': 'Note',
      '理由': 'Reason', '协议': 'Protocol',
      '供应': 'Supply', '借贷': 'Lending',
      '借款': 'Borrow', '存款人': 'Depositor',
      '榜单': 'Ranking', '排名': 'Rank',
      '上升': 'Up', '下降': 'Down',
      '榜单': 'Ranking',
      '登录成功': 'Login success', '登录失败': 'Login failed',
      '登录表单': 'Login form', '登录功能': 'Login function',
      '删除成功': 'Delete success',
      '删除记录': 'Delete record',
      '复制功能': 'Copy function', '列表功能': 'List function',
      '空回复': 'Empty reply', '无效': 'Invalid',
      '未配置': 'Not configured', '未启用': 'Not enabled',
      '未开始': 'Not started', '未验证': 'Unverified',
      '未通过': 'Not passed', '活跃': 'active',
      '已启用': 'Enabled', '已停用': 'Disabled',
      '已暂停': 'Paused', '已支付': 'Paid',
      '已执行': 'Executed', '已成交': 'Filled',
      '已撤销': 'Cancelled', '已确认': 'Confirmed',
      '已入账': 'Credited', '已到达提醒价格': 'Alert price reached',
      '已市价平仓': 'Market closed', '已强平': 'Liquidated',
      '已保存': 'Saved', '已完成': 'Completed',
      '已转账': 'Transferred', '已赎回': 'Redeemed',
      '已添加': 'Added', '已过期': 'Expired',
      '已连接': 'Connected', '已掉线': 'Disconnected',
      '已重连': 'Reconnected',
      '待审核': 'Pending', '正在提现': 'Withdrawing', '待确认': 'Pending confirm',
      '待调整预览': 'Pending adjust preview',
      '待领取收益': 'Pending rewards', '确认中': 'Confirming',
      '确认操作': 'Confirm action', '确认启动': 'Confirm start',
      '确认钱包': 'Confirm wallet', '确认进度': 'Confirm progress',
      '查看详情': 'View detail', '详情': 'Details',
      '记录不存在': 'Record not found',
      '共': 'Total', '显示': 'show',
      '资金': 'funds', '操作': 'action',
      '邮箱': 'email', '账号': 'account',
      '无需': 'no need', '钱包': 'Wallet',
      '个有正收益账户': 'accounts with profit',
      '有正收益账户': 'profitable accounts',
      '连接钱包即可进入；首次资金操作时再核对一次钱包，无需邮箱或其他账号': 'Connect wallet to enter; verify on first fund operation, no email needed',
      '连接钱包即可进入；首次充值、提现或交易时再核对一次钱包，无需邮箱或其他账号': 'Connect wallet to enter; verify on first deposit/withdraw/trade, no email needed',
      '未上榜': 'Not ranked', '上榜': 'ranked',
      '连接钱包后显示': 'Shows after wallet connected',
      '连接钱包后查看': 'Connect wallet to view',
      '显示 30D ROI': 'show 30D ROI',
      // 排行榜名次碎片（动态数值夹在中间，只能子串替换）
      '第 ': 'No.', ' 名': '',
    };
    // 1) 精确匹配替换 + 子串替换（遍历所有文本节点）
    // 合并主词典：_getDict() 新增 key 自动对动态内容生效，subMap 同名 key 优先
    // （v41：模块级懒初始化单例，保证正则/语言探测 WeakMap 缓存命中）
    if (!_mergedSub) _mergedSub = Object.assign({}, _getDict(), subMap);
    const mergedSub = _mergedSub;
    forEachPageTextNode(n => {
      const t = n.nodeValue;
      if (!t || !/[\u4e00-\u9fff]/.test(t)) return;
      // 精确匹配
      if (exactMap[t.trim()]) { n.nodeValue = exactMap[t.trim()]; return; }
      // 子串替换：v43 放开白皮书保护（exactAll 优先不中再 subAll），让文档大段长句也能翻译
      if (t.length < 200) {
        const modified = inWhitepaper(n.parentElement)
          ? (exactAll(mergedSub, t) !== t ? exactAll(mergedSub, t) : subAll(mergedSub, t))
          : subAll(mergedSub, t);
        if (modified !== t) n.nodeValue = modified;
      }
    });
    // 2) 翻译 input/textarea 的 placeholder + title + aria-label
    //    v65：此前只用 subMap，导致整句键（如文档标题）只能被碎片键半翻译；
    //    且漏扫 aria-label（价格类型/订单簿聚合精度/仓位比例永远停留中文）。
    //    与文本节点一致改用 mergedSub，并补齐 aria-label。
    document.querySelectorAll('input[placeholder], textarea[placeholder], [title], [aria-label]').forEach(el => {
      ['placeholder', 'title', 'aria-label'].forEach(attr => {
        if (!el.hasAttribute(attr)) return;
        const v = el.getAttribute(attr);
        if (!v || !/[\u4e00-\u9fff]/.test(v)) return;
        const nv = subAll(mergedSub, v);
        if (nv !== v) el.setAttribute(attr, nv);
      });
    });
    // 3) 翻译文档标题（v65：subMap → mergedSub，整句键优先于碎片键）
    if (document.title && /[\u4e00-\u9fff]/.test(document.title)) {
      const t = subAll(mergedSub, document.title);
      if (t !== document.title) document.title = t;
    }
    } else if (isZhLang(current)) {
      // ===== 英文 → 中文（反向翻译）=====
      // v41：白皮书静态区从未被正向改写，跳过还原（防反向词典污染双语字段）
      // v43 自愈网：切回中文后 20 秒内，页面若仍残留上一语言（假名/谚文/西里尔/带音标拉丁），
      // 先用 reverseFor(_lastNonZh) 还原，再做英→中反向。walkPage 漏扫、迟渲染的
      // 旧语言节点都能在下一周期自动修复 —— 页面不会停留在上一种语言。
      const hasLatin = /[A-Za-z]/.test(bodyTxt);
      const inHealWindow = _lastNonZh && _lastNonZh !== 'en' && _lastNonZh !== 'zh-TW'
        && Date.now() - _zhSince < 20000;
      const prevMap = inHealWindow ? reverseFor(_lastNonZh) : null;
      // 含字母类字符（拉丁/音标/西里尔/假名/谚文/汉字）的节点才值得跑反向词典
      const letterRe = /[A-Za-z\u00c0-\u024f\u0400-\u04ff\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/;
      const hasForeign = !!(prevMap && letterRe.test(bodyTxt));
      if (!hasLatin && !hasForeign) return;
      const revMap = getReverse();
      // 遍历所有文本节点
      forEachPageTextNode(n => {
        // v43：放开白皮书跳过 —— 白皮书现在也会被正向翻译，切回中文必须能还原
        let t = n.nodeValue;
        if (!t) return;
        if (prevMap && letterRe.test(t)) {
          const t2 = subAll(prevMap, t);
          if (t2 !== t) { n.nodeValue = t2; t = t2; }
        }
        if (!/[A-Za-z]/.test(t)) return;
        const nt = subAll(revMap, t);
        if (nt !== t) n.nodeValue = nt;
      });
      // 反向翻译 placeholder/title/aria-label
      document.querySelectorAll('input[placeholder], textarea[placeholder], [title], [aria-label]').forEach(el => {
        ['placeholder', 'title', 'aria-label'].forEach(attr => {
          if (!el.hasAttribute(attr)) return;
          const v = el.getAttribute(attr);
          let nv = subAll(revMap, v);
          if (prevMap && nv === v && letterRe.test(v)) nv = subAll(prevMap, v);
          if (nv !== v) el.setAttribute(attr, nv);
        });
      });
      // 反向翻译文档标题
      if (document.title) {
        const t = subAll(revMap, document.title);
        if (t !== document.title) document.title = t;
      }
    } else {
      if (!hasCjk) return;
      // ===== 其他语言（繁中/日/韩/俄/西）：全页正向子串替换 =====
      // mapFor(lang) = 英文兜底 + 该语言覆盖层，key 均为中文，只会命中中文文本，
      // 动态数值（价格/地址/百分比）不在词典中，天然保留
      walkPage(mapFor(current));
    }
  }

  // 翻译单个元素的所有文本子节点+后代属性（map 由调用方给定：正向或反向词典）
  // v41：单次正则替换引擎（subAll），杜绝连锁替换与反向值自命中膨胀
  // v43：放开白皮书跳过 —— 白皮书也要翻译，MutationObserver 才能处理文档内动态内容
  function translateEl(el, map) {
    if (!el) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(n => {
      if (n.parentElement?.closest('[data-nav-zh], [data-no-translate]')) return;
      const t = n.nodeValue;
      if (!t) return;
      // 白皮书内 exactAll 优先（保护双语字段），不中再 subAll；其他区域直接 subAll
      const nt = inWhitepaper(n.parentElement)
        ? (exactAll(map, t) !== t ? exactAll(map, t) : subAll(map, t))
        : subAll(map, t);
      if (nt !== t) n.nodeValue = nt;
    });
    // 翻译根节点及后代元素的属性（动态 order-book 行通常把提示写在根节点 title 上）
    ['placeholder', 'title', 'aria-label'].forEach(attr => {
      if (!el.hasAttribute?.(attr)) return;
      const v = el.getAttribute(attr);
      const nv = subAll(map, v);
      if (nv !== v) el.setAttribute(attr, nv);
    });
    // 翻译后代元素的属性
    el.querySelectorAll('*').forEach(child => {
      ['placeholder', 'title', 'aria-label'].forEach(attr => {
        if (!child.hasAttribute(attr)) return;
        const v = child.getAttribute(attr);
        const nv = subAll(map, v);
        if (nv !== v) child.setAttribute(attr, nv);
      });
    });
  }

  // 动态标签直写：zh → 中文原文；其他语言 → 覆盖层译文，未覆盖回落英文
  function translateDynamic() {
    const isZh = isZhLang(current);
    const extra = _getExtra()[current] || {};
    document.querySelectorAll('[data-nav-zh]').forEach(el => {
      const source=el.dataset.navZh;
      const target=isZh?source:(extra[source]||_getDict()[source]||source);
      if(el.textContent!==target)el.textContent=target;
    });
    for (const [sel, texts] of Object.entries(dynamicSel)) {
      const target = isZh ? texts.zh : (extra[texts.zh] || texts.en);
      if (!target) continue;
      document.querySelectorAll(sel).forEach(el => { if (el.textContent !== target) el.textContent = target; });
    }
  }

  function apply() {
    // v43：zh/en 分支的全页翻译与 translateDynamicSpecial 的对应分支完全等价
    // （同词典同 subAll，且后者覆盖面更全：含 title/aria-label 与文档标题）。
    // 此前的 areas 循环把全页文本节点又扫了一遍（.wrap 遍历整页 ×2），
    // 是切换语言时主线程卡顿的另一主因，这里去掉重复扫描。
    translateDynamic();
    translateDynamicSpecial();
    document.documentElement.lang = isZhLang(current) ? 'zh-CN' : current;
  }

  function set(lang) {
    if (!LANGS.some(([c]) => c === lang)) lang = 'zh';
    const prev = current;
    current = lang;
    if (isZhLang(lang)) _zhSince = Date.now(); else _lastNonZh = lang;
    try { localStorage.setItem(KEY, lang); } catch {}
    // 先挂上监控：即使下方切换过程异常，周期兜底也能自动完成翻译，不会卡在旧语言
    if (!window._i18nInterval) {
      window._i18nInterval = setInterval(() => {
        translateDynamicSpecial();
        translateDynamic();
      }, 2000);
    }
    setupObserver();
    // 非中文语言切换（含切回中文）：先还原中文，避免上一语言残留。
    // v42：此前条件要求目标语言也非中文，导致 X→中文 时只还原英文词典值，
    // 日/韩/俄/西的译文永远无法还原，页面停在上一语言（切换卡顿残留的根因）。
    if (!isZhLang(prev) && prev !== lang) {
      try { walkPage(reverseFor(prev)); } catch (err) { console.error('[i18n] reverse walk failed:', err); }
    }
    try { apply(); } catch (err) { console.error('[i18n] apply failed:', err); }
    // 迟渲染内容兜底：MutationObserver 已覆盖节点插入/文本变更，仅保留一次延迟补扫
    setTimeout(() => {
      try { apply(); } catch (err) { console.error('[i18n] apply failed:', err); }
    }, 800);
  }

  function init() {
    try { current = localStorage.getItem(KEY) || 'zh'; } catch {}
    if (!LANGS.some(([c]) => c === current)) current = 'zh'; // 旧存档非法值兜底
    if (!isZhLang(current)) {
      _lastNonZh = current;
      set(current); // 使用完整 set 流程（含持续监控）
    }
    // MutationObserver：始终启动（中英文双向翻译都需要）
    if (!window._i18nObserver) {
      setupObserver();
    }
  }

  function setupObserver() {
    if (window._i18nObserver) return;
    let timer = null;
    const pendingMutations = [];
    const flush = () => {
      timer = null;
      const mutations = pendingMutations.splice(0, pendingMutations.length);
      // 所有页面的动态模板（交易、赚取、资产、后台、Permit）都可能在
      // 首次语言初始化之后才插入 DOM。按变更节点翻译，避免只翻静态标题。
      const isZhNow = isZhLang(current);
      const map = isZhNow ? getReverse() : (current === 'en' ? _getDict() : mapFor(current));
      // v43：自愈窗口内新插入的节点若带上一语言残留，先还原再按当前语言翻译
      const healMap = (isZhNow && _lastNonZh && _lastNonZh !== 'en' && _lastNonZh !== 'zh-TW'
        && Date.now() - _zhSince < 20000) ? reverseFor(_lastNonZh) : null;
      if (map) {
        const targets = new Set();
        for (const m of mutations) {
          if (m.type === 'characterData') {
            if (m.target.parentElement) targets.add(m.target.parentElement);
          }
          m.addedNodes.forEach(n => {
            if (n.nodeType === Node.ELEMENT_NODE) targets.add(n);
            else if (n.nodeType === Node.TEXT_NODE && n.parentElement) targets.add(n.parentElement);
          });
        }
        targets.forEach(el => {
          // v43：白皮书现在也参与翻译（translateEl 内部 exactAll 优先保护双语字段）
          if (healMap) translateEl(el, healMap);
          translateEl(el, map);
        });
      }
      // 词典先处理完整短语，再运行兼容旧页面的动态碎片规则，避免生成中英混排。
      translateDynamicSpecial();
      translateDynamic();
    };
    window._i18nObserver = new MutationObserver((mutations) => {
      pendingMutations.push(...mutations);
      let hasText = false;
      for (const m of mutations) {
        if (m.type === 'characterData') hasText = true;
        if (m.addedNodes.length) hasText = true;
      }
      if (hasText && !timer) {
        timer = setTimeout(flush, 200);
      }
    });
    window._i18nObserver.observe(document.body, {
      childList: true, subtree: true, characterData: true,
    });
  }

  function toggle() { set(current === 'zh' ? 'en' : 'zh'); }

  return { set, init, toggle, langs: LANGS, get current() { return current; } };
})();

// 地球按钮下拉菜单
document.addEventListener('DOMContentLoaded', () => {
  window.I18n?.init();
  const btn = document.getElementById('lang-toggle');
  if (!btn) return;
  btn.innerHTML = '🌐';
  btn.onclick = null;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    let menu = document.getElementById('lang-menu');
    if (menu) { menu.remove(); return; }
    const langs = window.I18n?.langs || [['zh', '简体中文'], ['en', 'English']];
    const cur = window.I18n?.current || 'zh';
    menu = document.createElement('div');
    menu.id = 'lang-menu';
    menu.style.cssText = 'position:fixed;background:var(--panel,#16201d);border:1px solid var(--border,#1f2a26);border-radius:10px;padding:6px 0;z-index:9999;min-width:160px;box-shadow:0 8px 28px rgba(0,0,0,.5);overflow:hidden';
    const rect = btn.getBoundingClientRect();
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
    langs.forEach(([code, label]) => {
      const item = document.createElement('button');
      item.type = 'button';
      const active = code === cur;
      item.textContent = (active ? '✓ ' : '　') + label;
      item.style.cssText = 'display:block;width:100%;padding:8px 16px;border:0;background:transparent;color:'
        + (active ? 'var(--accent,#50d2c2)' : 'var(--txt,#e0e5e3)')
        + ';font:inherit;font-size:13px;text-align:left;cursor:pointer;white-space:nowrap';
      item.onmouseenter = () => item.style.background = 'var(--hover,#1f2a26)';
      item.onmouseleave = () => item.style.background = 'transparent';
      item.onclick = () => { menu.remove(); window.I18n.set(code); };
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
  });
  document.addEventListener('click', () => document.getElementById('lang-menu')?.remove());
});
