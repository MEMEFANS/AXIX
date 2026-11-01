// AIX 商城商户审核 + 订单总览（后台面板 /admin.html #mall）：入驻/关店审核、订单与担保在冻资金对账
(() => {
  const $ = id => document.getElementById(id);
  const STATUS = { pending: '入驻待审核', active: '已通过', rejected: '已拒绝', closing: '关店待审核', closed: '已关店' };
  const OSTATUS = { paid: '待发货', shipped: '已发货', completed: '已完成', cancelled: '已取消' };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = ts => { const d = new Date(Number(ts) || 0); return d.toLocaleString('zh-CN', { hour12: false }); };
  async function api(path, body) {
    const r = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `请求失败 (${r.status})`);
    return d;
  }
  async function load() {
    const root = $('admin-mall-list'); if (!root) return;
    const filter = $('admin-mall-filter')?.value ?? 'pending';
    root.innerHTML = '<div class="admin-inline-status">读取中…</div>';
    try {
      const { merchants } = await api(`/api/admin/mall/merchants?status=${encodeURIComponent(filter)}`);
      $('admin-mall-status').textContent = `共 ${merchants.length} 条`;
      root.innerHTML = '';
      if (!merchants.length) { root.innerHTML = '<div class="admin-inline-status">暂无记录</div>'; return; }
      for (const m of merchants) {
        const dep = m.deposit ? `${esc(m.deposit.amount)} ${esc(m.deposit.currency)}${m.deposit.refundedAt ? '（已退）' : ''}` : '—';
        const row = document.createElement('div');
        row.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:10px;padding:12px;border:1px solid var(--admin-line,#29413e);border-radius:8px;align-items:center';
        row.innerHTML = `<div><b>${esc(m.shopName)}</b> <span style="opacity:.7">${esc(m.walletMask || m.wallet)}</span>`
          + `<div style="font-size:12px;opacity:.75;margin-top:4px">${esc(m.intro || '')}</div>`
          + `<div style="font-size:12px;opacity:.6;margin-top:2px">保证金 ${dep} · 申请于 ${fmtTime(m.createdAt)} · ${STATUS[m.status] || esc(m.status)}</div></div>`;
        if (m.status === 'pending') {
          const ops = document.createElement('div'); ops.style.cssText = 'display:flex;gap:8px';
          const ok = document.createElement('button'); ok.className = 'admin-primary-button'; ok.type = 'button'; ok.textContent = '通过';
          ok.onclick = async () => {
            ok.disabled = true;
            try { await api('/api/admin/mall/merchants/approve', { wallet: m.wallet }); load(); }
            catch (e) { alert(e.message); ok.disabled = false; }
          };
          const no = document.createElement('button'); no.className = 'admin-secondary-button'; no.type = 'button'; no.textContent = '拒绝并退保证金';
          no.onclick = async () => {
            if (!confirm(`拒绝「${m.shopName}」入驻？保证金将自动退回申请人。`)) return;
            no.disabled = true;
            try { await api('/api/admin/mall/merchants/reject', { wallet: m.wallet }); load(); }
            catch (e) { alert(e.message); no.disabled = false; }
          };
          ops.append(ok, no); row.append(ops);
        }
        if (m.status === 'closing') {
          const ops = document.createElement('div'); ops.style.cssText = 'display:flex;gap:8px';
          const ok = document.createElement('button'); ok.className = 'admin-primary-button'; ok.type = 'button'; ok.textContent = '同意关店并退保证金';
          ok.onclick = async () => {
            if (!confirm(`同意「${m.shopName}」关店？保证金将自动退回商户平台余额。`)) return;
            ok.disabled = true;
            try { await api('/api/admin/mall/merchants/close-approve', { wallet: m.wallet }); load(); }
            catch (e) { alert(e.message); ok.disabled = false; }
          };
          const no = document.createElement('button'); no.className = 'admin-secondary-button'; no.type = 'button'; no.textContent = '驳回关店申请';
          no.onclick = async () => {
            no.disabled = true;
            try { await api('/api/admin/mall/merchants/close-reject', { wallet: m.wallet }); load(); }
            catch (e) { alert(e.message); no.disabled = false; }
          };
          ops.append(ok, no); row.append(ops);
        }
        root.append(row);
      }
    } catch (e) { root.innerHTML = `<div class="admin-inline-status">${esc(e.message)}</div>`; }
  }
  // ── 商城订单总览 + 担保在冻资金 ──
  async function loadOrders() {
    const root = $('admin-mall-orders'); if (!root) return;
    const filter = $('admin-mall-order-filter')?.value ?? '';
    root.innerHTML = '<div class="admin-inline-status">读取中…</div>';
    try {
      const { orders, escrowFrozenA } = await api(`/api/admin/mall/orders?status=${encodeURIComponent(filter)}&limit=100`);
      $('admin-mall-frozen').textContent = escrowFrozenA;
      $('admin-mall-order-status').textContent = `共 ${orders.length} 条`;
      root.innerHTML = '';
      if (!orders.length) { root.innerHTML = '<div class="admin-inline-status">暂无订单</div>'; return; }
      for (const o of orders) {
        const row = document.createElement('div');
        row.style.cssText = 'padding:12px;border:1px solid var(--admin-line,#29413e);border-radius:8px';
        const ship = o.shipCompany ? ` · 物流 ${esc(o.shipCompany)} ${esc(o.shipTracking || '')}` : '';
        row.innerHTML = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>${esc(o.productTitle)}</b>`
          + `<span style="opacity:.7">× ${o.quantity}</span><b style="color:#50d2c2">${esc(o.totalA)} AIX</b>`
          + `<span style="margin-left:auto;font-size:12px;opacity:.75">${OSTATUS[o.status] || esc(o.status)}</span></div>`
          + `<div style="font-size:12px;opacity:.7;margin-top:4px">店铺 ${esc(o.shopName)}（${esc(o.merchantMask)}）→ 买家 ${esc(o.buyerMask)} · 下单 ${fmtTime(o.createdAt)}${ship}</div>`
          + `<div style="font-size:11px;opacity:.5;margin-top:2px">${esc(o.id)}</div>`;
        root.append(row);
      }
    } catch (e) { root.innerHTML = `<div class="admin-inline-status">${esc(e.message)}</div>`; }
  }
  document.querySelector('[data-admin-page="mall"]')?.addEventListener('click', () => setTimeout(() => { load(); loadOrders(); }, 0));
  $('admin-mall-refresh')?.addEventListener('click', load);
  $('admin-mall-filter')?.addEventListener('change', load);
  $('admin-mall-order-refresh')?.addEventListener('click', loadOrders);
  $('admin-mall-order-filter')?.addEventListener('change', loadOrders);
})();
