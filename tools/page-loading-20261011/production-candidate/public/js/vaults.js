(function () {
  const P = Portal;
  function render() { document.getElementById('tab-vaults').innerHTML = `<div class="portal-shell">${P.header('金库', '浏览 Hyperliquid 协议与交易者金库', '<div class="portal-actions"><button class="portal-button primary" onclick="Portal.load(\'vaults\', true)">刷新金库</button></div>')}<div id="vaults-content">${P.loading(8)}</div></div>`; }
  async function load(context = { isCurrent:() => true }) {
    const host = document.getElementById('vaults-content'); host.innerHTML = P.loading(8);
    let vaults = await Hyperliquid.info('vaultSummaries');
    if (!Array.isArray(vaults)) vaults = vaults.vaults || vaults.data || [];
    if (!vaults.length) {
      const hlp = await Hyperliquid.info('vaultDetails', { vaultAddress:'0xdfc24b077bc1425ad1dea75bcb6f8158e10df303' });
      const portfolio = Object.fromEntries(hlp?.portfolio || []);
      const history = portfolio.allTime || portfolio.month || portfolio.day || {};
      const values = history.accountValueHistory || [];
      const pnls = history.pnlHistory || [];
      vaults = hlp ? [{ ...hlp, tvl:values.at(-1)?.[1], allTimePnl:pnls.at(-1)?.[1], numFollowers:hlp.followers?.length }] : [];
    }
    if (!context.isCurrent()) return;
    const normalized = vaults.map(item => ({
      address:item.vaultAddress || item.address, name:item.name || item.vaultName || 'Hyperliquid Vault',
      tvl:Number(item.tvl || item.accountValue || item.equity || 0), apr:Number(item.apr || item.apy || item.yearlyReturn || 0),
      pnl:Number(item.pnl || item.totalPnl || item.allTimePnl || 0), followers:Number(item.followers || item.numFollowers || item.nFollowers || 0),
    })).sort((a,b) => b.tvl - a.tvl);
    const rows = normalized.map((vault, index) => `<tr><td><strong>${P.esc(vault.name)}</strong><div class="portal-muted">${P.short(vault.address)}</div></td><td>${P.money(vault.tvl, 0)}</td><td class="${vault.apr >= 0 ? 'portal-positive' : 'portal-negative'}">${Math.abs(vault.apr) > 2 ? `${vault.apr.toFixed(2)}%` : P.percent(vault.apr)}</td><td class="${vault.pnl >= 0 ? 'portal-positive' : 'portal-negative'}">${P.money(vault.pnl)}</td><td>${P.number(vault.followers, 0)}</td><td><button class="portal-button" data-vault="${P.esc(vault.address)}">查看</button></td></tr>`).join('');
    const total = normalized.reduce((sum,item) => sum + item.tvl, 0);
    host.innerHTML = `<div class="portal-metrics">${P.metric('金库总资产', P.money(total, 0))}${P.metric('可用金库', P.number(normalized.length, 0))}${P.metric('协议', 'Hyperliquid')}${P.metric('结算资产', 'USDC')}</div><div class="portal-section"><div class="portal-section-head"><h2>所有金库</h2><span>按 TVL 排序</span></div><div class="portal-table-wrap"><table class="portal-table"><thead><tr><th>金库</th><th>TVL</th><th>年化收益</th><th>累计盈亏</th><th>存款人</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="6">暂无金库数据</td></tr>`}</tbody></table></div></div>`;
  }
  Portal.register('vaults', { render, load, fail:e => { document.getElementById('vaults-content').innerHTML = P.error(`金库数据暂不可用：${e.message}`, "Portal.load('vaults',true)"); } });
})();
