// Download and execute each feature only when its page is opened; shared scripts load once.
(() => {
  const scripts = new Map(), pages = new Map(), ready = new Set();
  const accountCore = ['/js/platform-client.js?v=5', '/js/trade-account.js?v=32-assets'];
  const chart = '/vendor/lightweight-charts.js?v=1';
  const groups = {
    trade: [...accountCore, chart, '/js/trade-chart.js?v=24', '/js/trade-history.js?v=1',
      '/js/trade-funding.js?v=2', '/js/trade-favorites.js?v=1', '/js/trade-trades.js?v=2',
      '/js/trade-depth.js?v=2', '/js/trade-book-tabs.js?v=1', '/js/trade-alerts.js?v=2', '/js/mobile-trade.js?v=10'],
    account: [...accountCore, '/js/wallet-funds.js?v=23', '/js/assets.js?v=20261011-aix-quantity', '/js/a-token-withdrawal.js?v=14', '/js/a-token-transfer.js?v=8'],
    'ai-managed': [...accountCore, '/js/ai-managed.js?v=30'],
    overview: [...accountCore, chart, '/js/strategy.js?v=25'],
    'a-token-trade': [chart, '/js/a-token-trade.js?v=50'],
    points: ['/js/lottery.js?v=58'],
    referrals: ['/js/referrals.js?v=15'],
    leaderboard: ['/js/leaderboard.js?v=16'],
    community: ['/js/community-links.js?v=2'],
    support: ['/js/support-chat.js?v=3'],
    portfolio: ['/js/hyperliquid-client.js?v=2', '/js/portfolio.js?v=2'],
    vaults: ['/js/hyperliquid-client.js?v=2', '/js/vaults.js?v=2'],
    staking: [...accountCore, '/js/staking.js?v=10'],
    ledger: ['/js/ledger.js?v=1'],
    ai: ['/js/wallet-funds.js?v=23', '/js/ai.js?v=3'],
  };
  for (const name of ['de','ex','rs']) groups[name] = groups.overview;

  function loadScript(src) {
    if (scripts.has(src)) return scripts.get(src);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = () => resolve();
      script.onerror = () => { script.remove(); reject(new Error('网络连接失败，请检查网络后重试')); };
      document.body.appendChild(script);
    });
    scripts.set(src, promise);
    promise.catch(() => scripts.delete(src));
    return promise;
  }

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
