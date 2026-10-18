// Independent pages download concurrently; only real dependencies order execution.
(() => {
  const scripts = new Map(), pages = new Map(), ready = new Set();
  const version = '20261011-pages-1';
  const js = name => `/js/${name}.js?v=${version}`;
  const chart = '/vendor/lightweight-charts.js?v=1';
  const deps = {
    'trade-account': ['platform-client'], assets: ['trade-account', 'wallet-funds'],
    'ai-managed': ['trade-account'], strategy: ['trade-account'], staking: ['trade-account', 'hyperliquid-client'],
    portfolio: ['hyperliquid-client'], vaults: ['hyperliquid-client'],
    'mobile-trade': ['trade-chart'], 'trade-alerts': ['trade-chart'],
    'trade-history': ['trade-account'],
  };
  const groups = {
    trade: ['trade-account', 'trade-chart', 'trade-history', 'trade-funding', 'trade-favorites',
      'trade-trades', 'trade-depth', 'trade-book-tabs', 'trade-alerts', 'mobile-trade'],
    account: ['assets'], 'ai-managed': ['ai-managed'], overview: ['strategy'],
    'a-token-trade': ['a-token-trade'], points: ['lottery'], referrals: ['referrals'],
    leaderboard: ['leaderboard'], community: ['community-links'], support: ['support-chat'],
    portfolio: ['portfolio'], vaults: ['vaults'], staking: ['staking'], ledger: ['ledger'], ai: ['ai'],
  };
  for (const name of ['de','ex','rs']) groups[name] = groups.overview;

  function loadScript(name) {
    const src = name.startsWith('/') ? name : js(name);
    if (scripts.has(src)) return scripts.get(src);
    const promise = Promise.all((deps[name] || []).map(loadScript)).then(() => new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => { script.remove(); reject(new Error('网络连接失败，请检查网络后重试')); };
      document.body.appendChild(script);
    }));
    scripts.set(src, promise);
    promise.catch(() => scripts.delete(src));
    return promise;
  }

  window.loadPageCharts = () => loadScript(chart);
  window.loadPageFeature = name => loadScript(name);
  window.loadPageModule = name => {
    if (!groups[name]) return Promise.resolve();
    if (pages.has(name)) return pages.get(name);
    const promise = Promise.all(groups[name].map(loadScript)).then(() => {
      if (name === 'trade' && !window.__tradeDeferredReady) {
        window.__tradeDeferredReady = true;
        window.__startTradeTerminal?.();
      }
      ready.add(name);
    });
    pages.set(name, promise);
    promise.catch(() => pages.delete(name));
    return promise;
  };
  window.isPageModuleReady = name => !groups[name] || ready.has(name);
})();
