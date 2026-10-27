const fs = require('fs');
function edit(file, run) {
  let s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const replace = (a, b) => { if (!s.includes(a)) throw new Error(`Missing ${file}: ${a.slice(0,80)}`); s = s.replace(a, b); };
  run(replace, () => s, value => s = value);
  fs.writeFileSync(file, s);
}
edit('resources/app/public/js/earn.js', (replace, read, write) => {
  replace("      retryPendingActivation();", "      retryPendingActivation();\n      retryAixActivation();");
  let s = read();
  s = s.replace(/    const activatedCount = plansCache\?\.activationMeta\?\.activatedCount \|\| 0;\n    const cap = [^\n]+\n    const capPct = [^\n]+\n/g, '');
  s = s.replaceAll('<p>BSC 主网 · 链上付款 · 矿机自动日结</p>', '<p>可用 AIX 激活 · 激活代币全额销毁 · 矿机自动日结</p>');
  const notice = `<div class="cap-wrap"><div class="cap-title">AIX 激活矿机<small>Mini 终身限一次 · Pro 激活无上限</small></div><p style="margin:8px 0 0;color:#a8bab6;font-size:12px">激活费用全额计入 AIX 交易大厅累计销毁${'${profileCache?.balances?.A != null ? \' · 可用余额 \' + fmtA(profileCache.balances.A) + \' AIX\' : \'\'}'}</p></div>`;
  s = s.replace(/<div class="cap-wrap">\n        <div class="cap-title">激活名额进度[\s\S]*?<div class="cap-bar">[^\n]+\n      <\/div>/g, notice);
  s = s.replace("    const collectionAddress = plansCache?.collectionAddress || '';\n", '');
  s = s.replace("${a.plan === '1' ? 'Mini 矿机 · 0.002 BNB' : 'Pro 矿机 · 0.05 BNB'}", "${a.plan === '1' ? 'Mini 矿机' : 'Pro 矿机'} · ${a.paymentAsset === 'AIX' ? escapeHtml(a.payload?.aix || '') + ' AIX' : (a.plan === '1' ? '0.002' : '0.05') + ' BNB（历史）'}");
  s = s.replace('<td data-label="交易哈希"><code title="${escapeHtml(a.txHash || \'\')}">${escapeHtml(String(a.txHash || \'\').slice(0, 12))}…</code></td>', '<td data-label="支付凭证">${a.paymentAsset === \'AIX\' ? \'<span title="\' + escapeHtml(a.id) + \'">可用 AIX · 已全额销毁</span>\' : \'<code title="\' + escapeHtml(a.txHash || \'\') + \'">\' + escapeHtml(String(a.txHash || \'\').slice(0, 12)) + \'…</code>\'}</td>');
  s = s.replace("${myActivations.length} 条${!collectionAddress ? ' · 当前未配置链上自动校验，后台将人工确认' : ' · 链上自动校验（' + (plansCache?.confirmations || 12) + ' 区块确认）'}", '${myActivations.length} 条 · AIX 激活即时到账');
  s = s.replace('<th>交易哈希</th>', '<th>支付凭证</th>');
  s = s.replace('去「激活」页面付款 0.002 / 0.05 BNB 激活，链上确认后矿机自动发放。', '去「激活」页面使用可用 AIX 激活：Mini 20 AIX，Pro 400 AIX，激活后立即发放。');
  // Preserve every Pro purchase in the local history.
  s = s.replace("const idx = list.findIndex(a => String(a.plan) === String(planKey));", "const record = activation?.record || activation || {};\n    const idx = record.id ? list.findIndex(a => a.id === record.id) : -1;");
  s = s.replace('const entry = { ...(activation || {}), plan: planKey, status };', 'const entry = { ...record, plan: planKey, status };');
  const start = s.indexOf('  // 激活防重入锁：');
  const end = s.indexOf('  // 激活提交后轮询状态:', start);
  if (start < 0 || end < 0) throw new Error('activation handler boundaries');
  s = s.slice(0, start) + `  // Keep the same request ID across timeouts, reloads and re-signing.
  const AIX_RETRY_KEY = 'axix_activation_aix_request_v1';
  let activationInFlight = false;
  const activationWallet = () => String(window.currentWalletConnection?.address || '').toLowerCase();
  const aixRetryStorageKey = () => AIX_RETRY_KEY + ':' + activationWallet();
  function readAixRetry() {
    try { return JSON.parse(localStorage.getItem(aixRetryStorageKey()) || 'null'); } catch { return null; }
  }
  function saveAixRetry(r) {
    localStorage.setItem(AIX_RETRY_KEY + ':' + r.wallet, JSON.stringify(r));
  }
  function clearAixRetry(r) {
    localStorage.removeItem(AIX_RETRY_KEY + ':' + r.wallet);
  }
  async function activationSucceeded(record, wallet) {
    if (wallet !== activationWallet()) return;
    applyActivationLocally(record.plan, record.status, record);
    clearProfileCache();
    window.dispatchEvent(new CustomEvent('aix:balance-changed'));
    showOk('激活成功，' + (record.payload?.aix || '') + ' AIX 已全额销毁，矿机已发放');
    const fresh = await authApi('profile').catch(() => null);
    if (wallet !== activationWallet()) return;
    if (fresh) { profileCache = fresh; writeProfileCache(wallet, fresh); }
    renderSubTab();
  }
  async function aixRequestStatus(r) {
    return (await authApi('activation-request?plan=' + encodeURIComponent(r.plan) + '&requestId=' + encodeURIComponent(r.requestId))).record;
  }
  async function submitAixRequest(r) {
    return (await authApi('activate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': r.requestId },
      body: JSON.stringify({ plan: r.plan, signature: r.signature, timestamp: r.timestamp }) })).activation.record;
  }
  async function retryAixActivation() {
    const r = readAixRetry();
    if (!r || r.wallet !== activationWallet() || activationInFlight) return;
    activationInFlight = true;
    try {
      let record = await aixRequestStatus(r);
      if (!record && Date.now() - Number(r.timestamp) < 240000) record = await submitAixRequest(r);
      if (record) { clearAixRetry(r); await activationSucceeded(record, r.wallet); }
      else showOk('有一笔激活尚未确认，点击激活可继续同一笔请求');
    } catch { /* Keep the durable request; the next click retries the same purchase. */ }
    finally { activationInFlight = false; renderSubTab(); }
  }
  window.earnActivate = async (planKey) => {
    if (activationInFlight) return;
    activationInFlight = true;
    const wallet = activationWallet();
    const provider = typeof connectedProvider !== 'undefined' ? connectedProvider : null;
    const assertWallet = () => {
      if (!wallet || wallet !== activationWallet() || provider !== connectedProvider) throw new Error('钱包账户已切换，请重新验证');
    };
    let pending;
    let requestSent = false;
    try {
      pending = readAixRetry();
      if (pending) {
        const record = await aixRequestStatus(pending);
        assertWallet();
        if (record) { clearAixRetry(pending); await activationSucceeded(record, wallet); return; }
        // Finish the unresolved purchase before creating another one.
        planKey = pending.plan;
      }
      plansCache = await fetchPlansFresh();
      assertWallet();
      if (plansCache.paymentMode !== 'aix_balance') throw new Error('激活规则正在更新，请稍后刷新页面');
      if (plansCache.activationEnabled === false) throw new Error('矿机激活暂未开放');
      const plan = plansCache.activation.find(p => p.plan === planKey);
      if (!plan || !['20', '400'].includes(plan.aix)) throw new Error('激活套餐无效，请刷新页面');
      profileCache = await authApi('profile');
      assertWallet();
      if (planKey === '1' && ((profileCache.activations || []).some(a => a.plan === '1' && a.status !== 'rejected')
          || (profileCache.miners || []).some(m => m.plan === 'mini120'))) throw new Error('Mini 矿机每个钱包终身仅可激活一次');
      const units = value => { const [n, d = ''] = String(value || '0').split('.'); return BigInt(n) * 10n ** 18n + BigInt(d.padEnd(18, '0').slice(0,18)); };
      if (units(profileCache.balances?.A) < units(plan.aix)) throw new Error('可用 AIX 余额不足，激活需 ' + plan.aix + ' AIX');
      if (!provider) throw new Error('请先连接钱包');
      if (!await confirmDialog('确认使用可用余额中的 ' + plan.aix + ' AIX 激活一台 ' + plan.name + '？代币将全额销毁，' + plan.days + ' 天总产出 ' + plan.total + ' AIX。' + (pending ? '本次将继续上次未确认的激活。' : ''))) return;
      assertWallet();
      const requestId = pending?.requestId || ('act_' + crypto.randomUUID().replaceAll('-', ''));
      const timestamp = String(Date.now());
      const message = 'AxiX 矿机激活确认：套餐 ' + planKey + '，销毁 ' + plan.aix + ' AIX，编号 ' + requestId + '，时间：' + timestamp;
      const signature = await provider.request({ method: 'personal_sign', params: [message, wallet] });
      assertWallet();
      pending = { wallet, plan: planKey, requestId, timestamp, signature };
      saveAixRetry(pending); // Persist before POST. A storage failure must never cause a purchase.
      requestSent = true;
      const record = await submitAixRequest(pending);
      clearAixRetry(pending);
      await activationSucceeded(record, wallet);
    } catch (e) {
      if (requestSent && pending && e.status >= 400 && e.status < 500) clearAixRetry(pending);
      showErr(friendlyError(e, '激活失败') + (requestSent && readAixRetry() ? '；结果待确认，再次点击会核对同一笔激活，请勿另行付款' : ''));
    } finally { activationInFlight = false; renderSubTab(); }
  };

` + s.slice(end);
  write(s);
});
edit('resources/app/public/js/operator-admin.js', (replace, read, write) => {
  let s = read().replaceAll('Mini（0.002 BNB）', 'Mini').replaceAll('Pro（0.05 BNB）', 'Pro')
    .replaceAll('Mini(0.002)', 'Mini').replaceAll('Pro(0.05)', 'Pro');
  s = s.replace("${a.plan === '1' ? 'Mini (0.002 BNB)' : a.plan === '2' ? 'Pro (0.05 BNB)' : '-'}", "${a.plan === '1' ? 'Mini' : 'Pro'} · ${a.paymentAsset === 'AIX' ? esc(a.payload?.aix || '') + ' AIX（已销毁）' : (a.plan === '1' ? '0.002' : '0.05') + ' BNB（历史）'}");
  const start = s.indexOf('      <div class="admin-a-card">\n        <h3>📈 矿机激活进度');
  const end = s.indexOf('      <div class="admin-a-card">', start + 50);
  if (start < 0 || end < 0) throw new Error('admin progress bounds');
  s = s.slice(0, start) + '      <div class="admin-a-card"><h3>AIX 激活规则</h3><p>Mini：20 AIX，终身限一次，30 天产出 100 AIX。Pro：400 AIX，可重复激活、同时持有多台，90 天产出 1500 AIX。无激活名额上限；激活费用全额计入销毁。</p></div>\n' + s.slice(end);
  const eventStart = s.indexOf('    // 填百分比自动换算人数');
  const eventEnd = s.indexOf("    $id('am-refresh')", eventStart);
  s = s.slice(0, eventStart) + s.slice(eventEnd);
  s = s.replace(/    const progCap = [^\n]+\n/, '').replace(/    const progCount = [^\n]+\n/, '').replace(/    const progReal = [^\n]+\n/, '').replace(/    const progPct = [^\n]+\n/, '').replace(/    const actMeta = [^\n]+\n/, '');
  write(s);
});
edit('resources/app/public/index.html', (replace) => {
  replace('用 BNB 链上支付激活矿机，链上确认后自动发放，产出 AIX，每日自动结算。', '使用平台可用 AIX 激活矿机，激活费用全额销毁并实时计入交易大厅累计销毁；矿机即时发放，每日自动结算。');
  replace('0.002 BNB</td>', '20 AIX</td>'); replace('0.05 BNB</td>', '400 AIX</td>');
  replace('每钱包 1 台</td>', '每钱包终身 1 台</td>'); replace('每钱包 1 台</td>', '不限次数及台数</td>');
  replace('/js/earn.js?v=20261015-activation-progress-1', '/js/earn.js?v=20261019-aix-activation-1');
  replace('/js/page-loader.js?v=20261019-transfer-precision-1', '/js/page-loader.js?v=20261019-aix-activation-1');
});
edit('resources/app/public/js/page-loader.js', replace => replace("'a-token-trade':'20261017-min100-1'", "'a-token-trade':'20261019-activation-burn-1'"));
edit('resources/app/public/admin.html', replace => replace('operator-admin.js?v=20261017-announce-3', 'operator-admin.js?v=20261019-aix-activation-1'));
