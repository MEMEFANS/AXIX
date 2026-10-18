(() => {
  const byId = id => document.getElementById(id);
  let credential = '', revision = 0, tab = 'withdrawals', automation = {}, creditRequest = null;
  let withdrawalsRevision = 0, creditsRevision = 0;
  const tabs = ['withdrawals','credits','assets','miners'];
  const operationRequests = new Map();
  // Remove the former page's saved secret. This console keeps credentials in memory only.
  try { sessionStorage.removeItem('wd_admin_token'); } catch {}
  const labels = { pending_review:'待人工审核', pending_funds:'待补款放行', pending_auto:'自动队列', processing:'准备出款', signed:'等待广播', broadcast:'链上确认中', payout_failed:'出款失败', paid:'已支付', rejected:'已拒绝', failed:'失败', refunded:'已退回' };
  function status(message, type = '') { byId('funds-status').textContent = message; byId('funds-status').className = `status ${type}`; }
  function lock() {
    credential = ''; revision++; withdrawalsRevision++; creditsRevision++; creditRequest = null; automation = {}; operationRequests.clear();
    byId('funds-token').value = ''; byId('funds-login').hidden = false; byId('funds-app').hidden = true; byId('funds-lock').hidden = true;
    byId('funds-withdrawals-body').replaceChildren(); byId('funds-credits-body').replaceChildren(); byId('funds-credit-form').reset(); byId('funds-settings-form').reset();
    byId('funds-assets-body').replaceChildren(); byId('funds-miners-body').replaceChildren(); byId('funds-asset-form').reset(); byId('funds-miner-form').reset();
  }
  async function api(path, options = {}) {
    if (!credential) throw new Error('请先验证资金管理权限');
    const current = revision;
    const response = await fetch(`/api/wallet/admin/${path}`, { ...options, credentials:'omit', cache:'no-store', signal:AbortSignal.timeout(20000), headers:{ 'Content-Type':'application/json', 'X-Wallet-Admin-Token':credential } });
    const data = await response.json();
    if (current !== revision) throw new Error('资金后台已锁定，请重新登录');
    if (response.status === 401) lock();
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  }
  function cell(row, value, className = '') { const td = document.createElement('td'); td.textContent = String(value ?? '—'); if (className) td.className = className; row.append(td); return td; }
  const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12:false }) : '—';
  function empty(body, columns, text) { const row = document.createElement('tr'); const td = cell(row, text, 'empty'); td.colSpan = columns; body.replaceChildren(row); }
  function action(host, text, kind, callback) { const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.className = kind; button.addEventListener('click', () => callback(button)); host.append(button); }
  function renderWithdrawals(items) {
    const body = byId('funds-withdrawals-body'); body.replaceChildren();
    byId('funds-withdrawal-count').textContent = `${items.length} 条记录`;
    for (const item of items) {
      const row = document.createElement('tr'); cell(row, date(item.createdAt)); cell(row, item.wallet, 'wallet'); cell(row, item.networkName || item.network); cell(row, `${item.amount} ${item.asset || 'USDT'}`); cell(row, labels[item.status] || item.status);
      const host = document.createElement('div'); host.className = 'actions'; cell(row, '').append(host);
      const retryable = item.status === 'payout_failed' && (!item.txHash || item.chainFailed);
      if (item.status === 'pending_review') {
        const hash = document.createElement('input'); hash.placeholder = '手动出款交易哈希（0x…）'; hash.setAttribute('aria-label', '手动出款交易哈希'); host.append(hash);
        action(host, '验链完成', 'secondary', button => processWithdrawal(item, 'approve', button, hash.value.trim()));
      }
      if (item.status === 'pending_review' || item.status === 'pending_funds' || retryable) {
        if (automation.enabled) action(host, retryable ? '重试出款' : '放行自动出款', '', button => processWithdrawal(item, retryable ? 'retry' : 'release', button));
        action(host, '拒绝退款', 'danger', button => processWithdrawal(item, 'reject', button));
      } else if (item.status !== 'pending_review') {
        const note = document.createElement('span'); note.className = 'note'; note.textContent = item.status === 'payout_failed' ? '已有链上交易，请核实出款状态' : item.reason || '—'; host.append(note);
      }
      body.append(row);
    }
    if (!items.length) empty(body, 6, '暂无提现记录');
  }
  async function loadSettings() {
    automation = await api('withdrawal-automation');
    byId('funds-auto-state').textContent = automation.enabled ? '自动提现已开启' : '自动提现已关闭';
    byId('funds-auto-enabled').checked = Boolean(automation.enabled); byId('funds-auto-threshold').value = automation.reviewThresholdUsdt || ''; byId('funds-auto-limit').value = automation.dailyLimitUsdt || ''; byId('funds-auto-ten').checked = Boolean(automation.usdtMultipleOfTen);
    byId('funds-settings-note').textContent = automation.configured ? '保存设置后生效。人工出款需填写真实交易哈希并通过链上核验。' : '自动出款尚未配置，可用真实出款交易哈希进行人工核验。';
  }
  async function loadWithdrawals() {
    const current = ++withdrawalsRevision;
    const data = await api(`withdrawals?status=${encodeURIComponent(byId('funds-withdrawal-filter').value)}`);
    if (current !== withdrawalsRevision) return;
    renderWithdrawals(data.items || []);
  }
  async function loadCredits() {
    const current = ++creditsRevision;
    const data = await api('test-credits');
    if (current !== creditsRevision) return;
    const body = byId('funds-credits-body'); body.replaceChildren();
    byId('funds-credit-count').textContent = `${data.items?.length || 0} 条记录`;
    for (const item of data.items || []) { const row = document.createElement('tr'); cell(row, date(item.createdAt)); cell(row, item.wallet, 'wallet'); cell(row, `${item.amount} ${item.asset || 'USDT'}`); cell(row, item.reason || '—'); cell(row, item.adminUsername || '—'); body.append(row); }
    if (!data.items?.length) empty(body, 5, '暂无测试入账记录');
  }
  async function refresh() {
    if (tab === 'credits') await loadCredits();
    else if (tab === 'assets') await loadAssets();
    else if (tab === 'miners') await loadMiners();
    else { await loadSettings(); await loadWithdrawals(); }
  }
  async function loadAssets() {
    const data = await api('asset-adjustments');
    const body = byId('funds-assets-body'); body.replaceChildren();
    byId('funds-asset-count').textContent = `${data.items?.length || 0} 条记录`;
    const operations = { funds_grant:'赠送', funds_debit:'扣除', admin_grant:'历史赠送', admin_debit:'历史扣除', admin_test_credit:'测试入账' };
    for (const item of data.items || []) {
      const row = document.createElement('tr'); cell(row,date(item.createdAt)); cell(row,item.wallet,'wallet'); cell(row,operations[item.type] || item.type);
      cell(row,`${item.amount} ${item.asset === 'A' ? 'AIX' : item.asset}`); cell(row,item.reason); cell(row,item.adminUsername); body.append(row);
    }
    if (!data.items?.length) empty(body,6,'暂无资产操作记录');
  }
  async function loadMiners() {
    const data = await api('miner-grants');
    const body = byId('funds-miners-body'); body.replaceChildren();
    byId('funds-miner-count').textContent = `${data.items?.length || 0} 条记录`;
    for (const item of data.items || []) {
      const row = document.createElement('tr'); cell(row,date(item.createdAt)); cell(row,item.wallet,'wallet'); cell(row,item.plan === 'mini120' ? 'Mini' : 'Pro');
      cell(row,item.miner?.id); cell(row,item.reason); cell(row,item.adminUsername); body.append(row);
    }
    if (!data.items?.length) empty(body,6,'暂无矿机赠送记录');
  }
  async function submitOperation(event, kind, payload, confirmation) {
    event.preventDefault();
    if (!window.confirm(confirmation)) return;
    const form = event.currentTarget, button = event.submitter || form.querySelector('button');
    const fingerprint = JSON.stringify(payload);
    let pending = operationRequests.get(kind);
    if (pending?.fingerprint !== fingerprint) {
      pending = { fingerprint, requestId:`${kind}_${crypto.randomUUID().replaceAll('-','')}` };
      operationRequests.set(kind,pending);
    }
    button.disabled = true;
    try {
      const result = await api(kind === 'asset' ? 'asset-adjustments' : 'miner-grants',{ method:'POST',body:JSON.stringify({...payload,requestId:pending.requestId}) });
      operationRequests.delete(kind); form.reset();
      status(kind === 'asset' ? `${result.adjustment.amount} ${payload.asset === 'A' ? 'AIX' : payload.asset} 已${payload.action === 'debit' ? '扣除' : '赠送'}` : '矿机已赠送','ok');
      if (kind === 'asset') await loadAssets(); else await loadMiners();
    } catch (error) { status(error.message,'error'); }
    finally { button.disabled = false; }
  }
  async function processWithdrawal(item, kind, button, txHash) {
    const body = { action:kind };
    if (kind === 'approve') {
      if (!/^0x[a-fA-F0-9]{64}$/.test(txHash || '')) return status('请输入正确的出款交易哈希', 'error');
      if (!window.confirm(`确认核验钱包 ${item.wallet} 的 ${item.amount} ${item.asset} 出款交易？`)) return;
      body.txHash = txHash;
    } else if (kind === 'reject') {
      const reason = window.prompt('请输入拒绝原因（余额将原额退回）', '人工审核未通过');
      if (reason === null) return;
      body.reason = reason.trim() || '人工审核未通过';
    } else if (!window.confirm(`确认${kind === 'retry' ? '重试' : '放行'}钱包 ${item.wallet} 的 ${item.amount} ${item.asset} 自动出款？`)) return;
    // Disable the entire row while an operation is pending, including conflicting actions.
    const buttons = [...button.closest('.actions').querySelectorAll('button')]; buttons.forEach(node => { node.disabled = true; });
    try { await api(`withdrawals/${encodeURIComponent(item.id)}`, { method:'POST', body:JSON.stringify(body) }); status(kind === 'approve' ? '链上核验通过，提现已完成' : kind === 'reject' ? '提现已拒绝，余额已退回' : '已加入自动出款队列', 'ok'); await loadWithdrawals(); }
    catch (error) { status(error.message, 'error'); }
    finally { buttons.forEach(node => { node.disabled = false; }); }
  }
  byId('funds-login-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter || event.currentTarget.querySelector('button'); button.disabled = true;
    credential = byId('funds-token').value.trim(); revision++;
    try { await api('session'); byId('funds-token').value = ''; byId('funds-login').hidden = true; byId('funds-app').hidden = false; byId('funds-lock').hidden = false; status('资金后台已解锁', 'ok'); await refresh(); }
    catch (error) { if (!byId('funds-login').hidden) lock(); status(error.message, 'error'); }
    finally { button.disabled = false; }
  });
  byId('funds-lock').addEventListener('click', () => { lock(); status('资金后台已锁定'); });
  for (const name of tabs) byId(`funds-tab-${name}`).addEventListener('click', async () => {
    tab = name;
    for (const target of tabs) { byId(`funds-${target}`).hidden = target !== name; const button = byId(`funds-tab-${target}`); button.classList.toggle('secondary', target !== name); button.setAttribute('aria-pressed', String(target === name)); }
    try { await refresh(); } catch (error) { status(error.message, 'error'); }
  });
  byId('funds-refresh').addEventListener('click', async () => { try { await refresh(); status('记录已刷新', 'ok'); } catch (error) { status(error.message, 'error'); } });
  byId('funds-withdrawal-filter').addEventListener('change', () => loadWithdrawals().catch(error => status(error.message, 'error')));
  byId('funds-asset-form').addEventListener('submit',event => {
    const payload = { wallet:byId('funds-asset-wallet').value.trim(), asset:byId('funds-asset-symbol').value, action:byId('funds-asset-action').value, amount:byId('funds-asset-amount').value.trim(), reason:byId('funds-asset-reason').value.trim() };
    submitOperation(event,'asset',payload,`确认给钱包 ${payload.wallet} ${payload.action === 'debit' ? '扣除' : '赠送'} ${payload.amount} ${payload.asset === 'A' ? 'AIX' : payload.asset}？`);
  });
  byId('funds-miner-form').addEventListener('submit',event => {
    const payload = { wallet:byId('funds-miner-wallet').value.trim(), plan:byId('funds-miner-plan').value, reason:byId('funds-miner-reason').value.trim() };
    submitOperation(event,'miner',payload,`确认给钱包 ${payload.wallet} 赠送一台 ${payload.plan === 'mini120' ? 'Mini' : 'Pro'} 矿机？`);
  });
  byId('funds-credit-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = event.submitter || form.querySelector('button');
    const payload = { wallet:byId('funds-credit-wallet').value.trim(), amount:byId('funds-credit-amount').value.trim(), reason:byId('funds-credit-reason').value.trim() };
    if (!window.confirm(`确认给钱包 ${payload.wallet} 增加 ${payload.amount} USDT 测试余额？`)) return;
    const fingerprint = JSON.stringify(payload);
    if (creditRequest?.fingerprint !== fingerprint) creditRequest = { fingerprint, requestId:`credit_${crypto.randomUUID().replaceAll('-', '')}` };
    payload.requestId = creditRequest.requestId; button.disabled = true; status('正在处理入账…');
    try { const result = await api('test-credits', { method:'POST', body:JSON.stringify(payload) }); creditRequest = null; form.reset(); status(`${result.adjustment.amount} USDT 已入账`, 'ok'); await loadCredits(); }
    catch (error) { status(error.message, 'error'); }
    finally { button.disabled = false; }
  });
  byId('funds-settings-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter || event.currentTarget.querySelector('button');
    if (!window.confirm('确认保存提现设置？')) return;
    button.disabled = true;
    try { await api('withdrawal-automation', { method:'PATCH', body:JSON.stringify({ enabled:byId('funds-auto-enabled').checked, reviewThresholdUsdt:byId('funds-auto-threshold').value, dailyLimitUsdt:byId('funds-auto-limit').value, usdtMultipleOfTen:byId('funds-auto-ten').checked }) }); status('提现设置已保存', 'ok'); await refresh(); }
    catch (error) { status(error.message, 'error'); }
    finally { button.disabled = false; }
  });
  window.addEventListener('pagehide', lock);
})();
