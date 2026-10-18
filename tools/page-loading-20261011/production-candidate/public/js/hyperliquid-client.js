(function () {
  async function json(url, options = {}) {
    if (window.Portal?.readJSON) return Portal.readJSON(url, options);
    const response = await fetch(url, { credentials:'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  }

  async function info(type, args = {}) {
    return json('/api/hyperliquid/info', {
      dedupe:true,
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ type, ...args }),
    });
  }

  function address() {
    return window.currentWalletConnection?.address || '';
  }

  window.Hyperliquid = {
    info,
    leaderboard:() => json('/api/hyperliquid/leaderboard'),
    address,
    userInfo:(type) => {
      const user = address();
      if (!user) throw new Error('请先连接钱包');
      return info(type, { user });
    },
  };
})();
