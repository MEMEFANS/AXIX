(function () {
  const P = Portal;
  const root = () => document.getElementById('tab-leaderboard');
  const usdt = value => `${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}`;
  const tone = value => Number(value || 0) >= 0 ? 'portal-positive' : 'portal-negative';
  const roiText = value => {
    const n = Number(value);
    return Number.isFinite(n) && Math.abs(n) > 0.000001 ? `${n.toFixed(2)}%` : '—';
  };

  function render() {
    root().innerHTML = `<div class="portal-shell">
      ${P.header('合约风云榜', '按合约跟单累计收益排名', '<div class="portal-actions"><button class="portal-button primary" id="leaderboard-refresh">刷新排名</button></div>')}
      <div id="leaderboard-content">${P.loading(8)}</div>
    </div>`;
    document.getElementById('leaderboard-refresh')?.addEventListener('click', () => P.load('leaderboard', true));
  }

  async function load(context = { isCurrent:() => true }) {
    const host = document.getElementById('leaderboard-content');
    if (!host) return;
    host.innerHTML = P.loading(8);
    const payload = await P.readJSON('/api/platform/leaderboard');
    if (!context.isCurrent()) return;
    const rows = payload.items || [];
    const top = rows[0];
    const current = payload.current;
    const authed = !!window.currentWalletProfile?.authenticated;
    const currentRank = current ? `第 ${current.rank} 名` : '未上榜';
    const myRankSub = current
      ? `30D 收益 ${usdt(current.earned30d)}`
      : (authed ? '' : '连接钱包后显示');
    const tableRows = rows.map(item => `<tr class="${item.isCurrent ? 'leaderboard-current' : ''}">
      <td data-label="排名"><span class="portal-rank">${item.rank}</span></td>
      <td data-label="账户"><strong>${P.esc(item.shortAddress)}</strong>${item.isCurrent ? '<span class="portal-chip">我的排名</span>' : ''}</td>
      <td data-label="累计跟单收益" class="portal-positive"><strong>${usdt(item.earned)}</strong></td>
      <td data-label="30D 收益" class="${tone(item.earned30d)}">${usdt(item.earned30d)}</td>
      <td data-label="30D ROI" class="${tone(item.roi30d)}">${roiText(item.roi30d)}</td>
      <td data-label="30D 交易量">${usdt(item.volume30d)}</td>
    </tr>`).join('');
    host.innerHTML = `
      <div class="portal-metrics leaderboard-metrics">
        ${P.metric('跟单账户', rows.length, `共 ${payload.total || 0} 个有跟单收益账户`)}
        ${P.metric('榜首 30D 收益', top ? `<span class="${tone(top.earned30d)}">${usdt(top.earned30d)}</span>` : '—', top ? `${roiText(top.roi30d)} ROI` : '暂无数据')}
        ${P.metric('我的排名', currentRank, myRankSub)}
      </div>
      <div class="portal-section leaderboard-section">
        <div class="portal-section-head"><h2>合约跟单收益排名</h2><span>按跟单累计收益排序 · 仅统计合约跟单</span></div>
        <div class="portal-table-wrap"><table class="portal-table leaderboard-table"><thead><tr>
          <th>排名</th><th>账户</th><th>累计跟单收益</th><th>30D 跟单收益</th><th>30D ROI</th><th>30D 跟单交易量</th>
        </tr></thead><tbody>${tableRows || '<tr><td colspan="6"><div class="portal-empty">暂无跟单收益账户</div></td></tr>'}</tbody></table></div>
        <p class="leaderboard-note">本榜仅统计合约跟单（AI 托管）的投入 USDT 与收益，不含现货交易、质押、矿机、推荐佣金、手续费返佣。30D ROI = 30D 跟单收益 ÷ 跟单投入 USDT。</p>
      </div>`;
  }

  P.register('leaderboard', { render, load, fail:error => {
    const host = document.getElementById('leaderboard-content');
    if (host) host.innerHTML = P.error(error.message, "Portal.load('leaderboard',true)");
  }});
})();
