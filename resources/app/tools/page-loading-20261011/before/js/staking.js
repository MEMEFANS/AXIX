(function () {
  const P = Portal;

  function render() {
    document.getElementById('tab-staking').innerHTML = `<div class="portal-shell">${P.header('质押', '平台 USDT 收益池与 Hyperliquid 验证者数据')}<div id="staking-content">${P.loading(8)}</div></div>`;
  }

  async function platformAction(action) {
    const input = document.getElementById('platform-stake-amount');
    const amount = input.value.trim();
    if (!amount || Number(amount) <= 0) return showToast('请输入正确的 USDT 数量', 'error');
    try {
      await ensurePlatformSession();
      await PlatformClient.staking(action, amount);
      input.value = '';
      await loadWalletProfile();
      await loadPlatformProfile();
      await load(true);
      showToast(action === 'stake' ? '质押成功' : '赎回成功', 'ok');
    } catch (error) { showToast(error.message, 'error'); }
  }

  async function load() {
    const host = document.getElementById('staking-content');
    const user = window.currentWalletProfile?.authenticated ? window.currentWalletProfile.address : '';
    if (!user) { host.innerHTML = P.platformGate('连接并确认钱包后使用质押和查看委托'); return; }
    host.innerHTML = P.loading(8);
    const [platform, validators] = await Promise.all([
      PlatformClient.profile(),
      Hyperliquid.info('validatorSummaries').catch(() => []),
    ]);
    const stake = platform.staking || {};
    const available = window.currentWalletProfile?.balances?.USDT || 0;
    const totalStake = (validators || []).reduce((sum,item) => sum + Number(item.stake || 0) / 1e8, 0);
    const validatorRows = (validators || []).sort((a,b) => Number(b.stake)-Number(a.stake)).slice(0,30).map((item,index) => `<tr><td><span class="portal-rank">${index + 1}</span> <strong>${P.esc(item.name || P.short(item.validator))}</strong></td><td>${P.number(Number(item.stake || 0) / 1e8, 2)} HYPE</td><td>${P.percent((Number(item.stake || 0) / 1e8) / (totalStake || 1))}</td><td class="${item.isJailed ? 'portal-negative' : 'portal-positive'}">${item.isJailed ? '已暂停' : '活跃'}</td></tr>`).join('');
    host.innerHTML = `<div class="portal-metrics">${P.metric('可用余额', `${P.number(available, 6)} USDT`)}${P.metric('已质押', `${P.number(stake.principal, 6)} USDT`)}${P.metric('累计收益', `${P.number(stake.rewards, 6)} USDT`)}${P.metric('当前年化', P.percent(stake.apy || 0))}</div><div class="portal-grid-2"><div class="portal-section"><div class="portal-section-head"><h2>平台 USDT 收益池</h2><span>内部资金账户</span></div><div class="staking-form"><label>数量</label><div><input id="platform-stake-amount" type="number" min="0" step="0.01" placeholder="0.00"><span>USDT</span></div><div class="portal-actions"><button class="portal-button primary" onclick="platformStakeAction('stake')">质押</button><button class="portal-button" onclick="platformStakeAction('unstake')">赎回</button></div></div></div><div class="portal-section"><div class="portal-section-head"><h2>资金状态</h2><span>随时赎回</span></div><div class="staking-summary"><p><span>质押 USDT</span><strong>${P.number(stake.principal, 6)} USDT</strong></p><p><span>待领取收益</span><strong>${P.number(stake.rewards, 6)} USDT</strong></p><p><span>收益方式</span><strong>按时间累计</strong></p></div></div></div><div class="portal-section"><div class="portal-section-head"><h2>Hyperliquid 验证者</h2><span>只读链上数据</span></div><div class="portal-table-wrap"><table class="portal-table"><thead><tr><th>验证者</th><th>委托量</th><th>占比</th><th>状态</th></tr></thead><tbody>${validatorRows || '<tr><td colspan="4">暂无验证者数据</td></tr>'}</tbody></table></div></div>`;
  }

  window.platformStakeAction = platformAction;
  P.register('staking', { render, load, fail:e => { document.getElementById('staking-content').innerHTML = P.error(e.message, "Portal.load('staking',true)"); } });
})();
