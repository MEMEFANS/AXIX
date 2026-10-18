// AIX 代币链上提现（BSC）· 钱包页内嵌 modal · 前端统一以 AIX 为显示单位
// 依赖：window.atradeApi（或通用 fetch + 钱包 session）；用 window.WalletApi 也可
// 全部用原生 JS 自渲染 modal，不依赖 portal 现有组件
(function () {
  const STATUS_LABEL = {
    pending: '待处理', manual_review: '正在提现', processing: '出款中',
    signed: '已签名', broadcast: '链上确认中', paid: '已到账',
    failed: '失败已退回', rejected: '已拒绝', cancelled: '已撤销',
  };
  const STATUS_CLASS = {
    pending: 'pending', manual_review: 'pending', processing: 'pending',
    signed: 'pending', broadcast: 'pending', paid: 'credited',
    failed: 'rejected', rejected: 'rejected', cancelled: 'rejected',
  };

  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  function shortAddr(a) { a = String(a || ''); return a.length > 12 ? `${a.slice(0,6)}…${a.slice(-4)}` : a; }
  function fmtTime(t) { return t ? new Date(Number(t)).toLocaleString('zh-CN', { hour12:false }) : '-'; }
  function fmtA(s) { const n = Number(s || '0'); return n.toLocaleString('en-US', { maximumFractionDigits:4 }); }

  async function api(path, options = {}) {
    const headers = options.headers || {};
    if (options.body) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '请求失败，请重试');
    return data;
  }

  function ensureModal() {
    let modal = $('atoken-withdrawal-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'atoken-withdrawal-modal';
    modal.className = 'awd-modal';
    modal.innerHTML = `
      <div class="awd-backdrop" data-awd-close="1"></div>
      <div class="awd-dialog">
        <div class="awd-header">
          <h3>AIX 链上提现</h3>
          <button class="awd-close" data-awd-close="1" aria-label="关闭">×</button>
        </div>
        <div class="awd-body">
          <div class="awd-tabs">
            <button class="awd-tab active" data-awd-tab="form">提现</button>
            <button class="awd-tab" data-awd-tab="records">我的提现</button>
          </div>
          <div class="awd-pane" data-awd-pane="form">
            <div class="awd-status" id="awd-status"></div>
            <div class="awd-field">
              <label>提现数量（AIX）</label>
              <input id="awd-amount" type="number" step="0.0001" min="0" placeholder="最小 100 AIX">
              <div class="awd-hint">单笔 100 - 500,000 AIX · 单日累计上限 2,000,000 AIX</div>
            </div>
            <div class="awd-field">
              <label>BSC 收款地址（当前连接钱包）</label>
              <div id="awd-to-address" class="awd-readonly-addr" title="">未连接钱包</div>
              <div class="awd-hint">为防止钓鱼与误转，链上提现只能提到当前连接的钱包地址，不可手动输入</div>
            </div>
            <div class="awd-quote" id="awd-quote">
              <div class="awd-quote-row"><span>提现金额</span><b id="awd-q-amount">-</b></div>
              <div class="awd-quote-row"><span>手续费（0.5%, ≥5 AIX）</span><b id="awd-q-fee">-</b></div>
              <div class="awd-quote-row"><span>实际到账（链上）</span><b id="awd-q-receive">-</b></div>
              <div class="awd-quote-row"><span>本次扣减内盘余额</span><b id="awd-q-need">-</b></div>
              <div class="awd-quote-row"><span>可用 AIX 余额</span><b id="awd-q-balance">-</b></div>
              <div class="awd-quote-row"><span>预计到账时间</span><b id="awd-q-eta">~36 秒</b></div>
              <div class="awd-quote-row"><span>路径</span><b>BSC（AIX BEP-20 代币）</b></div>
            </div>
            <button id="awd-submit" class="awd-submit">确认提现</button>
          </div>
          <div class="awd-pane" data-awd-pane="records" hidden>
            <div class="awd-status" id="awd-records-status"></div>
            <div class="awd-table-wrap">
              <table class="awd-table">
                <thead><tr><th>时间</th><th>数量</th><th>手续费</th><th>收款地址</th><th>状态</th><th>Tx</th><th>操作</th></tr></thead>
                <tbody id="awd-records-body">
                  <tr><td colspan="7" class="account-empty">点击「刷新」加载</td></tr>
                </tbody>
              </table>
            </div>
            <button id="awd-refresh" class="awd-refresh">刷新</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target.dataset.awdClose === '1') close();
    });
    modal.querySelector('[data-awd-tab="form"]').addEventListener('click', () => switchTab('form'));
    modal.querySelector('[data-awd-tab="records"]').addEventListener('click', () => { switchTab('records'); loadRecords(); });
    modal.querySelector('#awd-amount').addEventListener('input', debounce(loadQuote, 300));
    modal.querySelector('#awd-submit').addEventListener('click', submit);
    modal.querySelector('#awd-refresh').addEventListener('click', loadRecords);
    return modal;
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function switchTab(name) {
    const modal = ensureModal();
    modal.querySelectorAll('.awd-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.awdTab === name));
    modal.querySelectorAll('.awd-pane').forEach(pane => pane.hidden = pane.dataset.awdPane !== name);
  }

  function setStatus(text, kind = 'info') {
    const el = $('awd-status') || $('awd-records-status');
    if (!el) return;
    el.className = `awd-status awd-status-${kind}`;
    el.textContent = text || '';
  }

  async function loadQuote() {
    const amount = Number($('awd-amount')?.value || 0);
    if (!amount || amount <= 0) {
      ['awd-q-amount','awd-q-fee','awd-q-receive','awd-q-need','awd-q-balance'].forEach(id => {
        const el = $(id); if (el) el.textContent = '-';
      });
      return;
    }
    try {
      const q = await api(`/api/a-token/withdraw/quote?amount=${encodeURIComponent(amount)}`);
      if (!q.ok) {
        setStatus(q.error || '报价失败', 'error');
        return;
      }
      $('awd-q-amount').textContent = fmtA(q.amountA) + ' A';
      $('awd-q-fee').textContent = fmtA(q.feeA) + ' A';
      $('awd-q-receive').textContent = fmtA(q.receiveA) + ' A';
      $('awd-q-need').textContent = fmtA(q.needBalanceA) + ' A';
      $('awd-q-balance').textContent = fmtA(q.balanceA) + ' A';
      $('awd-q-eta').textContent = `~${q.estimatedSeconds || 36} 秒`;
      setStatus('');
    } catch (e) {
      setStatus(e.message?.includes('请') ? e.message : '获取报价失败，请重试', 'error');
    }
  }

  async function submit() {
    const btn = $('awd-submit');
    if (btn) btn.disabled = true;
    try {
      const amount = Number($('awd-amount').value || 0);
      // 提现地址强制取当前连接钱包（后端会再次校验 toAddress === session.address）
      const toAddress = String(window.currentWalletConnection?.address || '').trim();
      if (!amount || amount <= 0) throw new Error('请输入提现金额');
      if (amount < 100) throw new Error('最小提现金额为 100 AIX');
      if (!/^0x[a-fA-F0-9]{40}$/.test(toAddress)) throw new Error('请先连接钱包再提现');
      setStatus('正在提交...', 'info');
      // 钱包签名确认提现（签名绑定幂等编号，后端按编号幂等防重放/双扣款）
      if (!connectedProvider || !connectedWalletAddress) { setStatus('请先连接钱包', 'error'); return; }
      setStatus('请在钱包中签名确认提现...', 'info');
      const timestamp = String(Date.now());
      const idempotencyKey = `awd_${Date.now()}_${Math.random().toString(16).slice(2,10)}`;
      const message = `AxiX AIX提现确认：数量 ${String(amount)} AIX，编号 ${idempotencyKey}，时间：${timestamp}`;
      let signature;
      try {
        signature = await connectedProvider.request({ method: 'personal_sign', params: [message, connectedWalletAddress] });
      } catch (signError) {
        if (Number(signError?.code) === 4001 || /denied|rejected|cancel/i.test(signError?.message || '')) { setStatus('已取消提现', 'info'); return; }
        throw signError;
      }
      const result = await api('/api/a-token/withdraw', {
        method: 'POST',
        body: JSON.stringify({ amount: String(amount), signature, timestamp }), // 不再传 toAddress，后端强制用 session.address
        idempotencyKey,
      });
      const w = result.withdrawal;
      setStatus(`已提交，正在自动出款 ${fmtA(w.amountA)} AIX 到 ${shortAddr(w.toAddress)}`, 'ok');
      $('awd-amount').value = '';
      loadQuote();
      if (typeof loadWalletProfile === 'function') loadWalletProfile();
    } catch (e) {
      if (Number(e?.code) === 4001 || /denied|rejected|cancel/i.test(e?.message || '')) { setStatus('已取消提现', 'info'); return; }
      setStatus(e.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function loadRecords() {
    setStatus('加载中...', 'info');
    try {
      const data = await api('/api/a-token/withdrawals?limit=50');
      const list = data.withdrawals || [];
      const body = $('awd-records-body');
      if (!body) return;
      if (!list.length) {
        body.innerHTML = '<tr><td colspan="7" class="account-empty">暂无提现记录</td></tr>';
        setStatus('');
        return;
      }
      body.innerHTML = list.map(r => {
        const statusLabel = STATUS_LABEL[r.status] || r.status;
        const statusClass = STATUS_CLASS[r.status] || 'pending';
        const tx = r.txHash ? `<a href="https://bscscan.com/tx/${escapeHtml(r.txHash)}" target="_blank" rel="noopener" style="color:#93c5fd">${escapeHtml(shortAddr(r.txHash))}</a>` : '-';
        const canCancel = ['pending', 'manual_review'].includes(r.status);
        const cancelBtn = canCancel ? `<button class="awd-cancel" data-id="${escapeHtml(r.id)}">撤销</button>` : '-';
        const failNote = r.failReason ? `<div class="awd-fail" title="${escapeHtml(r.failReason)}">${escapeHtml(r.failReason)}</div>` : '';
        return `<tr>
          <td>${escapeHtml(fmtTime(r.createdAt))}</td>
          <td>${escapeHtml(fmtA(r.amountA))} AIX</td>
          <td>${escapeHtml(fmtA(r.feeA))} AIX</td>
          <td><code title="${escapeHtml(r.toAddress)}">${escapeHtml(shortAddr(r.toAddress))}</code></td>
          <td><span class="status-chip ${escapeHtml(statusClass)}">${escapeHtml(statusLabel)}</span>${failNote}</td>
          <td>${tx}</td>
          <td>${cancelBtn}</td>
        </tr>`;
      }).join('');
      body.querySelectorAll('.awd-cancel').forEach(btn => {
        btn.addEventListener('click', () => cancelWithdrawal(btn.dataset.id));
      });
      setStatus('');
    } catch (e) {
      setStatus(e.message?.includes('请') ? e.message : '加载记录失败，请重试', 'error');
    }
  }

  async function cancelWithdrawal(id) {
    if (!await confirmDialog('确定撤销这笔 AIX 提现申请吗？撤销后 AIX 余额立即返回。')) return;
    try {
      setStatus('正在撤销...', 'info');
      await api(`/api/a-token/withdraw/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setStatus('已撤销，AIX 余额已返回', 'ok');
      loadRecords();
      if (typeof loadWalletProfile === 'function') loadWalletProfile();
    } catch (e) {
      setStatus(e.message?.includes('请') ? e.message : '撤销失败，请重试', 'error');
    }
  }

  async function open() {
    // 先检查提现开关
    try {
      const pool = await api('/api/a-token/pool');
      if (pool.withdrawEnabled === false) {
        if (typeof showToast === 'function') showToast('AIX 提现暂未开放，请留意平台公告', 'error');
        else alert('AIX 提现暂未开放，请留意平台公告');
        return;
      }
    } catch {}
    ensureModal();
    document.getElementById('atoken-withdrawal-modal').classList.add('awd-show');
    switchTab('form');
    // 填充当前连接钱包地址（只读）
    const addrEl = $('awd-to-address');
    const addr = String(window.currentWalletConnection?.address || '').trim();
    if (addrEl) {
      addrEl.textContent = addr ? shortAddr(addr) : '未连接钱包';
      addrEl.title = addr;
    }
    if (!addr) {
      setStatus('请先连接钱包再进行链上提现', 'error');
    } else {
      setStatus('');
    }
    loadQuote();
  }

  function close() {
    const m = $('atoken-withdrawal-modal');
    if (m) m.classList.remove('awd-show');
  }

  window.ATokenWithdrawal = { open, close };
})();
