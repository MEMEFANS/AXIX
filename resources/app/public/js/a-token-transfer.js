// AIX 互转 · 资产页 AIX 行内嵌 modal · 前端统一以 AIX 为显示单位
// 依赖：window.loadWalletProfile / window.currentWalletProfile（portal 全局）
// 全部原生 JS 自渲染 modal，复用 a-token-withdrawal 的 .awd-* 样式
(function () {
  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  function fmtA(s) { const n = Number(s || '0'); return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits:4 }) : '0'; }

  async function api(path, options = {}) {
    const headers = options.headers || {};
    if (options.body) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function setStatus(text, kind = 'info') {
    const el = $('at-status');
    if (!el) return;
    el.className = `awd-status awd-status-${kind}`;
    el.textContent = text || '';
  }

  function ensureModal() {
    let modal = $('atoken-transfer-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'atoken-transfer-modal';
    modal.className = 'awd-modal';
    modal.innerHTML = `
      <div class="awd-backdrop" data-at-close="1"></div>
      <div class="awd-dialog">
        <div class="awd-header">
          <h3>AIX 互转</h3>
          <button class="awd-close" data-at-close="1" aria-label="关闭">×</button>
        </div>
        <div class="awd-body">
          <div class="awd-status" id="at-status"></div>
          <div class="awd-field">
            <label>接收方 · 用户 ID</label>
            <input id="at-uid" placeholder="请输入对方用户 ID（8位字母数字）" autocomplete="off" style="width:100%;box-sizing:border-box">
            <div class="awd-hint">请向对方确认用户 ID · 转账不可撤销</div>
          </div>
          <div class="awd-field">
            <label>转让数量（AIX）</label>
            <input id="at-amount" type="number" min="0" step="any" placeholder="请输入 AIX 数量">
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:6px">
              <button type="button" class="at-pct" data-pct="25" style="background:#101a1c;border:1px solid #29413e;color:#9fb0ad;border-radius:6px;padding:6px 0;cursor:pointer;font-size:11px">25%</button>
              <button type="button" class="at-pct" data-pct="50" style="background:#101a1c;border:1px solid #29413e;color:#9fb0ad;border-radius:6px;padding:6px 0;cursor:pointer;font-size:11px">50%</button>
              <button type="button" class="at-pct" data-pct="75" style="background:#101a1c;border:1px solid #29413e;color:#9fb0ad;border-radius:6px;padding:6px 0;cursor:pointer;font-size:11px">75%</button>
              <button type="button" class="at-pct" data-pct="100" style="background:#101a1c;border:1px solid #29413e;color:#9fb0ad;border-radius:6px;padding:6px 0;cursor:pointer;font-size:11px">全部</button>
            </div>
            <div class="awd-hint">最少互转 <b style="color:#50d2c2">20 AIX</b> 起</div>
            <div class="awd-hint">我的 AIX 余额：<b id="at-balance" style="color:#50d2c2">0 AIX</b></div>
            <div class="awd-hint" id="at-fee-hint" style="color:#f6c454">手续费率加载中…</div>
          </div>
          <div class="awd-quote">
            <div class="awd-quote-row"><span>转让总量</span><b id="at-q-amt">0 AIX</b></div>
            <div class="awd-quote-row"><span id="at-q-fee-lbl">💥 手续费（50%）</span><b id="at-q-fee" style="color:#f26c78">- 0 AIX</b></div>
            <div class="awd-quote-row"><span>　└ 销毁（手续费 50%）</span><b id="at-q-burn" style="color:#f26c78">- 0 AIX</b></div>
            <div class="awd-quote-row"><span>　└ 分红池（手续费 50%）</span><b id="at-q-div" style="color:#f6c454">- 0 AIX</b></div>
            <div class="awd-quote-row"><span>✅ 对方实收</span><b id="at-q-net" style="color:#50d2c2">0 AIX</b></div>
          </div>
          <button id="at-submit" class="awd-submit" style="background:linear-gradient(135deg,#f26c78,#c8324a)">⚠️ 确认互转（手续费由您承担）</button>
          <div style="margin-top:14px;border-top:1px solid #1c2a28;padding-top:10px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
              <span style="font-size:12px;color:#9fb0ad;font-weight:600">最近互转记录</span>
              <a href="javascript:void(0)" id="at-history-all" style="font-size:11px;color:#50d2c2;text-decoration:none">全部记录 →</a>
            </div>
            <div id="at-history"></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target.dataset.atClose === '1') close(); });
    modal.querySelector('#at-amount').addEventListener('input', refreshFee);
    modal.querySelectorAll('.at-pct').forEach(b => b.addEventListener('click', () => fillPct(b.dataset.pct)));
    modal.querySelector('#at-submit').addEventListener('click', submit);
    modal.querySelector('#at-history-all').addEventListener('click', () => {
      close();
      if (typeof switchTab === 'function') switchTab('account');
      setTimeout(() => window.ExchangeAssets?.setView('records'), 800);
    });
    return modal;
  }

  // 当前钱包手续费率（bps），打开弹窗时从 /api/a-token/transfer-quote 拉取；
  // 与 AIX 交易卖盘同一阶梯：直推 0~1→50%, 2~3→40%, 4~5→30%, 6~7→20%, 8~9→10%, ≥10→3%
  let feeRateBps = 5000;
  let directCount = 0;

  function refreshFee() {
    const n = Number($('at-amount')?.value || 0);
    const fee = n * feeRateBps / 10000;
    const burn = fee / 2;        // 手续费的 50% 销毁
    const div = fee - burn;      // 手续费的 50% 进分红池
    const net = n - fee;
    const pct = (feeRateBps / 100).toFixed(0);
    if ($('at-q-fee-lbl')) $('at-q-fee-lbl').textContent = `💥 手续费（${pct}%）`;
    if ($('at-q-amt')) $('at-q-amt').textContent = fmtA(n) + ' AIX';
    if ($('at-q-fee')) $('at-q-fee').textContent = '- ' + fmtA(fee) + ' AIX';
    if ($('at-q-burn')) $('at-q-burn').textContent = '- ' + fmtA(burn) + ' AIX';
    if ($('at-q-div')) $('at-q-div').textContent = '- ' + fmtA(div) + ' AIX';
    if ($('at-q-net')) $('at-q-net').textContent = fmtA(net) + ' AIX';
  }

  function amountUnits(value) {
    const match = /^(\d+)(?:\.(\d{0,18}))?$/.exec(String(value || '').trim());
    if (!match) throw new Error('请输入有效的 AIX 数量（最多 18 位小数）');
    return BigInt(match[1]) * 10n ** 18n + BigInt((match[2] || '').padEnd(18, '0'));
  }

  function fillPct(pct) {
    const units = amountUnits(window.__atTransferBalanceA || '0') * BigInt(pct) / 100n;
    // Truncate to eight display decimals without rounding above the ledger balance.
    const ticks = units / 10n ** 10n;
    const fraction = (ticks % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
    if ($('at-amount')) $('at-amount').value = (ticks / 100000000n).toString() + (fraction ? '.' + fraction : '');
    refreshFee();
  }

  async function loadProfileIntoModal() {
    // 一次拉取 /api/a-token/profile：拿 userId + balances.A，填进 modal
    try {
      const prof = await api('/api/a-token/profile');
      window.__atTransferMyUid = prof?.userId || '';
      window.__atTransferBalanceA = String(prof?.balances?.A || '0');
      if ($('at-balance')) $('at-balance').textContent = fmtA(window.__atTransferBalanceA) + ' AIX';
    } catch {
      window.__atTransferMyUid = '';
      window.__atTransferBalanceA = 0;
      if ($('at-balance')) $('at-balance').textContent = '0 AIX';
    }
    // 拉取当前钱包的阶梯手续费率（按直推有效人数）
    try {
      const q = await api('/api/a-token/transfer-quote');
      feeRateBps = Number(q?.feeRateBps ?? 5000) || 5000;
      directCount = Number(q?.directCount ?? 0) || 0;
      const pct = (feeRateBps / 100).toFixed(0);
      const hint = $('at-fee-hint');
      if (hint) {
        hint.innerHTML = `我的手续费率 <b style="color:#f6c454">${pct}%</b>（直推有效 ${directCount} 人）· 手续费由转让方承担，50% 销毁 + 50% 进分红池`;
      }
    } catch {
      const hint = $('at-fee-hint');
      if (hint) hint.textContent = '手续费率：默认 50%（直推人数越多费率越低，最低 3%）';
    }
    refreshFee();
  }

  async function submit() {
    const btn = $('at-submit');
    if (btn) btn.disabled = true;
    try {
      const uid = $('at-uid')?.value?.trim();
      const amt = $('at-amount')?.value?.trim();
      if (!uid || !amt) { setStatus('请填写接收方用户 ID 和转让数量', 'error'); return; }
      const n = Number(amt);
      if (!Number.isFinite(n) || n <= 0) { setStatus('请输入有效的 AIX 数量', 'error'); return; }
      if (n < 20) { setStatus('AIX 互转最低 20 个起', 'error'); return; }
      const bal = window.__atTransferBalanceA || '0';
      if (amountUnits(amt) > amountUnits(bal)) { setStatus(`AIX 余额不足 · 当前可用 ${fmtA(bal)} AIX`, 'error'); return; }
      setStatus('正在提交...', 'info');
      // 钱包签名确认互转（签名绑定幂等编号，后端按编号幂等防重放/双转）
      if (!connectedProvider || !connectedWalletAddress) { setStatus('请先连接钱包', 'error'); return; }
      setStatus('请在钱包中签名确认互转...', 'info');
      const timestamp = String(Date.now());
      const idempotencyKey = `at_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
      const message = `AxiX 互转确认：数量 ${amt} AIX，收款方 ${uid}，编号 ${idempotencyKey}，时间：${timestamp}`;
      let signature;
      try {
        signature = await connectedProvider.request({ method:'personal_sign', params:[message, connectedWalletAddress] });
      } catch (signError) {
        if (Number(signError?.code) === 4001 || /denied|rejected|cancel/i.test(signError?.message || '')) { setStatus('已取消互转', 'info'); return; }
        throw signError;
      }
      const r = await api('/api/a-token/transfer', {
        method: 'POST',
        body: JSON.stringify({ toUserId: uid, amount: amt, signature, timestamp }),
        idempotencyKey,
      });
      setStatus(`互转成功 · 对方实收 ${fmtA(r?.net)} AIX，手续费 ${fmtA(r?.fee)} AIX（${r?.feePct || (feeRateBps / 100).toFixed(0) + '%'}）`, 'ok');
      if ($('at-uid')) $('at-uid').value = '';
      if ($('at-amount')) $('at-amount').value = '';
      refreshFee();
      await loadProfileIntoModal();
      loadHistory();
      if (typeof loadWalletProfile === 'function') loadWalletProfile();
    } catch (e) {
      if (Number(e?.code) === 4001 || /denied|rejected|cancel/i.test(e?.message || '')) { setStatus('已取消互转', 'info'); return; }
      setStatus(e.message || '互转失败，请重试', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ── 最近互转记录（/api/a-token/my-transfers 最近 5 条）：互转弹窗内直接看 ──
  function shortAddr(a) { return a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : '—'; }
  function historyEmpty(text) { return `<div style="font-size:11px;color:#6b7f7c;padding:8px 0">${text}</div>`; }
  function historyRow(t) {
    const out = t.direction === 'out';
    const when = new Date(Number(t.createdAt) || 0).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    // 转出展示总额（自担手续费），转入按净额到账
    const amt = fmtA(out ? t.amount : (t.payload?.net ?? t.amount));
    const who = out ? ('ID ' + escapeHtml(t.toUserId || '')) : shortAddr(t.counterparty);
    return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-top:1px dashed #1c2a28;font-size:12px">
      <span style="display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden">
        <span class="aix-tf-badge ${out ? 'out' : 'in'}">${out ? '转出' : '转入'}</span>
        <span style="color:#c6d4d1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${who}</span>
        <span style="color:#6b7f7c;white-space:nowrap">${when}</span>
      </span>
      <b style="color:${out ? '#f26c78' : '#50d2c2'};white-space:nowrap">${out ? '−' : '+'}${amt} AIX</b>
    </div>`;
  }
  async function loadHistory() {
    const host = $('at-history');
    if (!host) return;
    if (!window.currentWalletProfile?.authenticated) { host.innerHTML = historyEmpty('连接钱包后可查看互转记录'); return; }
    host.innerHTML = historyEmpty('加载中…');
    try {
      const data = await api('/api/a-token/my-transfers');
      const list = Array.isArray(data?.transfers) ? data.transfers : [];
      if (!list.length) { host.innerHTML = historyEmpty('暂无互转记录'); return; }
      host.innerHTML = list.slice(0, 5).map(historyRow).join('');
    } catch {
      host.innerHTML = historyEmpty('记录加载失败，请重试');
    }
  }

  async function open() {
    ensureModal();
    $('atoken-transfer-modal').classList.add('awd-show');
    setStatus('');
    if ($('at-uid')) $('at-uid').value = '';
    if ($('at-amount')) $('at-amount').value = '';
    refreshFee();
    if (!window.currentWalletProfile?.authenticated) {
      setStatus('请先连接钱包再进行 AIX 互转', 'error');
      return;
    }
    await loadProfileIntoModal();
    loadHistory();
  }

  function close() {
    const m = $('atoken-transfer-modal');
    if (m) m.classList.remove('awd-show');
  }

  window.ATokenTransfer = { open, close };
})();
