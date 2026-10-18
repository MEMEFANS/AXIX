(function () {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  })[char]);
  const tokenInput = () => document.getElementById('withdraw-admin-token');
  const status = (message, type = '') => {
    const node = document.getElementById('withdraw-admin-status');
    if (!node) return;
    node.textContent = message;
    node.className = `account-status${type ? ` ${type}` : ''}`;
  };
  const token = () => String(tokenInput()?.value || '').trim();

  async function api(path, options = {}) {
    const value = token();
    if (!value) throw new Error('请输入 WALLET_ADMIN_TOKEN');
    const response = await fetch(path, {
      credentials:'same-origin', ...options,
      headers:{ 'Content-Type':'application/json', 'X-Wallet-Admin-Token':value, ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  }

  async function load(force = false) {
    if (!force && !token()) return;
    const body = document.getElementById('withdraw-admin-body');
    try {
      const data = await api('/api/wallet/admin/withdrawals?status=pending_review');
      body.innerHTML = (data.items || []).map(item => `<tr>
        <td>${esc(new Date(item.createdAt).toLocaleString('zh-CN', { hour12:false }))}</td>
        <td>${esc(item.networkName || item.network)}</td>
        <td title="${esc(item.wallet)}">${esc(item.wallet)}</td>
        <td>${esc(item.asset)}</td><td>${esc(item.amount)}</td>
        <td><input class="withdraw-admin-hash" id="withdraw-hash-${esc(item.id)}" placeholder="0x 出款交易哈希"></td>
        <td><div class="withdraw-admin-actions"><button class="table-action" onclick="approveAdminWithdrawal('${esc(item.id)}')">验链完成</button><button class="table-action danger" onclick="rejectAdminWithdrawal('${esc(item.id)}')">拒绝退款</button></div></td>
      </tr>`).join('') || '<tr><td colspan="7" class="account-empty">暂无待审核提现</td></tr>';
      status(`已读取 ${data.items?.length || 0} 笔待审核申请`, 'ok');
    } catch (error) { status(error.message, 'error'); }
  }

  async function process(id, payload) {
    try {
      await api(`/api/wallet/admin/withdrawals/${encodeURIComponent(id)}`, { method:'POST', body:JSON.stringify(payload) });
      status(payload.action === 'approve' ? '链上交易核验通过，提现已完成' : '提现已拒绝，余额已原额退回', 'ok');
      await load(true);
    } catch (error) { status(error.message, 'error'); }
  }

  window.loadAdminWithdrawals = load;
  window.approveAdminWithdrawal = (id) => {
    const txHash = document.getElementById(`withdraw-hash-${id}`)?.value.trim();
    if (!txHash) return status('请输入出款交易哈希', 'error');
    return process(id, { action:'approve', txHash });
  };
  window.rejectAdminWithdrawal = async (id) => {
    const reason = await promptDialog('请输入拒绝原因（余额将原额退回）', '人工审核未通过');
    if (reason === null) return;
    return process(id, { action:'reject', reason });
  };
})();
