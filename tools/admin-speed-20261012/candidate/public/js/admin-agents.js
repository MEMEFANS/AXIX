(function () {
  const byId = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
  const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12:false }) : '-';

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { credentials:'same-origin', ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `请求失败 (${response.status})`);
    return payload;
  }

  async function loadAgents() {
    const listEl = byId('admin-agents-list');
    const statusEl = byId('admin-agents-list-status');
    if (!listEl) return;
    statusEl.textContent = '加载中...';
    try {
      const { agents } = await api('/api/admin/agents');
      if (!agents.length) {
        listEl.innerHTML = '<p style="color:var(--admin-muted);margin:12px 0">暂无代理账号</p>';
        statusEl.textContent = '';
        return;
      }
      listEl.innerHTML = agents.map(a => `
        <div class="admin-content-block" style="margin-bottom:12px;padding:14px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
            <div>
              <div style="font-weight:600">${esc(a.username)}
                <span style="margin-left:8px;padding:2px 8px;border-radius:4px;font-size:12px;background:${a.status==='active'?'var(--admin-green)':'var(--admin-red)'};color:#fff">${a.status==='active'?'启用':'禁用'}</span>
              </div>
              <div style="font-family:monospace;font-size:12px;color:var(--admin-muted);margin-top:4px;word-break:break-all">${esc(a.walletAddress)}</div>
              <div style="font-size:12px;color:var(--admin-muted);margin-top:2px">创建：${date(a.createdAt)}${a.createdBy?' · 操作人 '+esc(a.createdBy):''}</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button type="button" class="admin-secondary-button" data-action="toggle" data-id="${esc(a.id)}" data-status="${esc(a.status)}">${a.status==='active'?'禁用':'启用'}</button>
              <button type="button" class="admin-secondary-button" data-action="password" data-id="${esc(a.id)}">重置密码</button>
              <button type="button" class="admin-secondary-button" data-action="wallet" data-id="${esc(a.id)}">改钱包</button>
              <button type="button" class="admin-secondary-button" data-action="delete" data-id="${esc(a.id)}" style="color:var(--admin-red)">删除</button>
            </div>
          </div>
        </div>`).join('');
      statusEl.textContent = `共 ${agents.length} 个代理`;
    } catch (err) { statusEl.textContent = err.message; }
  }

  function bindForm() {
    const form = byId('admin-agents-form');
    if (!form || form.dataset.bound) return;
    form.dataset.bound = '1';
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const statusEl = byId('admin-agents-form-status');
      try {
        statusEl.textContent = '创建中...';
        await api('/api/admin/agents', {
          method:'POST',
          body: JSON.stringify({
            username: byId('agent-username').value.trim(),
            password: byId('agent-password').value,
            walletAddress: byId('agent-wallet').value.trim(),
          }),
        });
        form.reset();
        statusEl.style.color = 'var(--admin-green)';
        statusEl.textContent = '代理创建成功';
        loadAgents();
      } catch (err) {
        statusEl.style.color = 'var(--admin-red)';
        statusEl.textContent = err.message;
      }
    });
  }

  function bindActions() {
    const list = byId('admin-agents-list');
    if (!list || list.dataset.bound) return;
    list.dataset.bound = '1';
    list.addEventListener('click', async e => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      try {
        if (action === 'toggle') {
          const next = btn.dataset.status === 'active' ? 'disabled' : 'active';
          await api(`/api/admin/agents/${id}/status`, { method:'POST', body: JSON.stringify({ status: next }) });
        } else if (action === 'password') {
          const pw = prompt('请输入新密码（至少 6 位）：');
          if (!pw) return;
          await api(`/api/admin/agents/${id}/password`, { method:'POST', body: JSON.stringify({ password: pw }) });
          alert('密码已重置');
        } else if (action === 'wallet') {
          const wallet = prompt('请输入新的绑定钱包地址：');
          if (!wallet) return;
          await api(`/api/admin/agents/${id}/wallet`, { method:'POST', body: JSON.stringify({ walletAddress: wallet }) });
          alert('钱包已更新');
        } else if (action === 'delete') {
          if (!confirm('确定删除该代理？删除后不可恢复。')) return;
          await api(`/api/admin/agents/${id}`, { method:'DELETE' });
        }
        loadAgents();
      } catch (err) { alert(err.message); }
    });
  }

  byId('admin-agents-refresh')?.addEventListener('click', loadAgents);

  // 由主导航和全局刷新按钮统一调用，避免进入页面时重复读取。
  window.AdminAgents = { load() { bindForm(); bindActions(); return loadAgents(); } };

  // 如果默认就在代理页
  if (document.querySelector('[data-admin-panel="agents"].active')) {
    bindForm(); bindActions(); loadAgents();
  }
})();
