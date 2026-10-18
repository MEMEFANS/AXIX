// 积分抽奖后台管理：概率配置 / 社交审核 / 实物发货 / 指定中奖
window.AdminLottery = (() => {
  let api, toast;
  let tab = 'prob';
  let prizes = [];
  let socialList = [], socialStatus = 'pending';
  let physicalList = [], physicalStatus = 'pending_address';
  let assignedList = [];
  let styleInjected = false;

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const dt = v => v ? new Date(v).toLocaleString('zh-CN', { hour12:false }) : '-';
  const short = a => { const s = String(a || ''); return s.length > 18 ? `${s.slice(0, 8)}...${s.slice(-6)}` : s || '-'; };
  const pct = v => `${(Number(v) * 100).toFixed(2)}%`;

  const STATUS_MAP = {
    pending: ['待审核', 'warn'], approved: ['已通过', 'good'], rejected: ['已拒绝', 'bad'],
    pending_address: ['待填地址', 'warn'], pending_ship: ['待发货', 'warn'], shipped: ['已发货', 'good'],
  };
  const statusBadge = st => {
    const [label, cls] = STATUS_MAP[st] || [st, ''];
    return `<span class="admin-status ${cls || ''}">${esc(label)}</span>`;
  };

  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .al-tabs{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
      .al-tab{padding:8px 18px;border:1px solid var(--admin-line,#202927);border-radius:8px;background:var(--admin-panel,#0f1413);color:var(--admin-text,#e8efed);cursor:pointer;font-size:13px;transition:all .2s}
      .al-tab:hover{border-color:var(--admin-green,#4fd1b5)}
      .al-tab.active{background:var(--admin-green,#4fd1b5);color:#071312;border-color:var(--admin-green,#4fd1b5);font-weight:600}
      .al-block{border:1px solid var(--admin-line,#202927);border-radius:10px;padding:14px;margin-bottom:16px;background:var(--admin-panel-2,#121817)}
      .al-block h3{margin:0 0 4px;font-size:14px;color:var(--admin-text,#e8efed)}
      .al-block .al-hint{font-size:12px;color:var(--admin-muted,#82908c);margin:0 0 10px}
      .al-total{font-size:13px;font-weight:600}
      .al-total.bad{color:var(--admin-red,#f06b78)}
      .al-total.good{color:var(--admin-green,#4fd1b5)}
      .al-table{width:100%;border-collapse:collapse;font-size:13px;color:var(--admin-text,#e8efed)}
      .al-table th,.al-table td{padding:8px 6px;border-bottom:1px solid var(--admin-line,#202927);text-align:left;vertical-align:middle}
      .al-table th{color:var(--admin-muted,#82908c);font-weight:500;font-size:12px}
      .al-table input[type=text],.al-table input[type=number],.al-table select{padding:5px 8px;border:1px solid var(--admin-line,#202927);border-radius:6px;font-size:13px;background:var(--admin-bg,#0a0e0d);color:var(--admin-text,#e8efed)}
      .al-table input[type=number]{width:90px;text-align:right}
      .al-btn{padding:5px 12px;border:none;border-radius:6px;background:var(--admin-green,#4fd1b5);color:#071312;cursor:pointer;font-size:12px;font-weight:600;margin-right:6px}
      .al-btn.secondary{background:transparent;color:var(--admin-red,#f06b78);border:1px solid var(--admin-red,#f06b78)}
      .al-btn:disabled{opacity:.5;cursor:not-allowed}
      .al-filter{margin-bottom:10px}
      .al-filter select{padding:5px 10px;border:1px solid var(--admin-line,#202927);border-radius:6px;font-size:13px;background:var(--admin-bg,#0a0e0d);color:var(--admin-text,#e8efed)}
      .al-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;align-items:end}
      .al-form label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--admin-muted,#82908c)}
      .al-form input,.al-form select{padding:7px 10px;border:1px solid var(--admin-line,#202927);border-radius:6px;font-size:13px;background:var(--admin-bg,#0a0e0d);color:var(--admin-text,#e8efed)}
      .al-form input:focus,.al-form select:focus,.al-table input:focus{outline:none;border-color:var(--admin-green,#4fd1b5)}
      .al-shot{color:var(--admin-green,#4fd1b5);text-decoration:underline;cursor:pointer;word-break:break-all}
      .al-addr{font-size:12px;line-height:1.5}
      .al-empty{color:var(--admin-muted,#82908c);text-align:center;padding:18px;font-size:13px}
    `;
    document.head.appendChild(style);
  }

  function renderShell() {
    injectStyle();
    const root = document.getElementById('admin-lottery-root');
    if (!root) return;
    root.innerHTML = `
      <div class="al-tabs">
        <button class="al-tab ${tab === 'prob' ? 'active' : ''}" data-al-tab="prob">🎯 奖品概率</button>
        <button class="al-tab ${tab === 'social' ? 'active' : ''}" data-al-tab="social">📣 社交审核</button>
        <button class="al-tab ${tab === 'physical' ? 'active' : ''}" data-al-tab="physical">📦 实物发货</button>
        <button class="al-tab ${tab === 'assigned' ? 'active' : ''}" data-al-tab="assigned">🎯 指定中奖</button>
        <button class="al-tab ${tab === 'topup' ? 'active' : ''}" data-al-tab="topup">💰 积分充值</button>
      </div>
      <div id="al-content"></div>`;
    root.querySelectorAll('[data-al-tab]').forEach(btn => {
      btn.addEventListener('click', () => { tab = btn.dataset.alTab; renderShell(); refreshTab(); });
    });
  }

  function refreshTab() {
    if (tab === 'prob') renderProb();
    else if (tab === 'social') renderSocial();
    else if (tab === 'physical') renderPhysical();
    else if (tab === 'topup') renderTopup();
    else renderAssigned();
  }

  // ── 概率配置 ──────────────────────────────────────────────
  async function loadPrizes() {
    try {
      const result = await api('/api/admin/lottery/prizes');
      prizes = result.prizes || [];
      if (tab === 'prob') renderProb();
    } catch (e) { toast(e.message); }
  }

  function renderProb() {
    const host = document.getElementById('al-content');
    if (!host) return;
    const total = prizes.reduce((s, p) => s + Number(host.querySelector(`[data-prob="${p.id}"]`)?.value ?? (p.probability * 100)), 0);
    const cryptoPrizes = prizes.filter(p => p.type === 'crypto');
    host.innerHTML = `
      <div class="al-block">
        <h3>奖品中奖概率</h3>
        <p class="al-hint">概率单位为 %，所有奖品总和必须等于 100%。留空的奖品保持默认值。保存后立即生效（无需重启）。</p>
        <table class="al-table">
          <thead><tr><th>奖品</th><th>类型</th><th>默认概率</th><th>当前概率 (%)</th></tr></thead>
          <tbody>
            ${prizes.map(p => `<tr>
              <td>${esc(p.name)}${p.symbol ? ` <small style="color:#888">(${esc(p.symbol)})</small>` : ''}</td>
              <td>${p.type === 'crypto' ? '币奖' : p.type === 'physical' ? '实物' : '谢谢参与'}</td>
              <td style="color:#888">${pct(p.defaultProbability)}</td>
              <td><input type="number" step="0.0001" min="0" max="100" value="${(Number(p.probability) * 100).toFixed(4).replace(/\.?0+$/, '')}" data-prob="${esc(p.id)}"></td>
            </tr>`).join('')}
          </tbody>
        </table>
        <div style="margin-top:12px;display:flex;align-items:center;gap:14px">
          <span>当前总和：<span class="al-total ${Math.abs(total - 100) < 0.01 ? 'good' : 'bad'}" id="al-prob-total">${total.toFixed(2)}%</span></span>
          <button class="al-btn" id="al-prob-save">保存概率</button>
          <button class="al-btn secondary" id="al-prob-reset" style="border-color:#888;color:#888">恢复默认</button>
        </div>
      </div>
      <div class="al-block">
        <h3>币奖价值区间</h3>
        <p class="al-hint">设置每种币单次中奖的数量区间（单位：枚），按对数分布随机发放，保存后立即生效。留空表示保持当前值；点"恢复默认"回到系统内置区间。设置后 USDT 原有的分段分布（80%小额/20%大额）会被替换为统一区间。</p>
        <table class="al-table">
          <thead><tr><th>奖品</th><th>默认区间</th><th>当前区间下限</th><th>当前区间上限</th><th>操作</th></tr></thead>
          <tbody>
            ${cryptoPrizes.map(p => `<tr>
              <td>${esc(p.name)}${p.symbol ? ` <small style="color:#888">(${esc(p.symbol)})</small>` : ''}</td>
              <td style="color:#888">${esc(p.defaultAmountMin)} ~ ${esc(p.defaultAmountMax)}</td>
              <td><input type="number" step="any" min="0" value="${esc(p.amountMin ?? '')}" data-amin="${esc(p.id)}" style="width:120px"></td>
              <td><input type="number" step="any" min="0" value="${esc(p.amountMax ?? '')}" data-amax="${esc(p.id)}" style="width:120px"></td>
              <td><button class="al-btn secondary" data-areset="${esc(p.id)}" style="border-color:#888;color:#888" ${p.amountOverridden ? '' : 'disabled'}>恢复默认</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
        <div style="margin-top:12px">
          <button class="al-btn" id="al-amount-save">保存区间</button>
        </div>
      </div>`;
    host.querySelectorAll('[data-prob]').forEach(input => {
      input.addEventListener('input', () => {
        const t = prizes.reduce((s, p) => s + Number(host.querySelector(`[data-prob="${p.id}"]`)?.value || 0), 0);
        const el = document.getElementById('al-prob-total');
        el.textContent = `${t.toFixed(2)}%`;
        el.className = `al-total ${Math.abs(t - 100) < 0.01 ? 'good' : 'bad'}`;
      });
    });
    document.getElementById('al-prob-save').addEventListener('click', saveProb);
    document.getElementById('al-prob-reset').addEventListener('click', resetProb);
    document.getElementById('al-amount-save').addEventListener('click', saveAmounts);
    host.querySelectorAll('[data-areset]').forEach(btn => {
      btn.addEventListener('click', () => resetAmount(btn.dataset.areset));
    });
  }

  async function saveProb() {
    const host = document.getElementById('al-content');
    const probabilities = {};
    prizes.forEach(p => {
      const raw = host.querySelector(`[data-prob="${p.id}"]`)?.value;
      if (raw !== '' && raw !== undefined) probabilities[p.id] = Number(raw);
    });
    try {
      const result = await api('/api/admin/lottery/prizes', { method:'POST', body: JSON.stringify({ probabilities }) });
      prizes = result.prizes || prizes;
      toast('✓ 概率已保存并生效');
      renderProb();
    } catch (e) { toast(e.message); }
  }

  async function resetProb() {
    const probabilities = {};
    prizes.forEach(p => { probabilities[p.id] = Number((p.defaultProbability * 100).toFixed(4)); });
    try {
      const result = await api('/api/admin/lottery/prizes', { method:'POST', body: JSON.stringify({ probabilities }) });
      prizes = result.prizes || prizes;
      toast('✓ 已恢复默认概率');
      renderProb();
    } catch (e) { toast(e.message); }
  }

  // ── 价值区间配置 ──────────────────────────────────────────
  async function saveAmounts() {
    const host = document.getElementById('al-content');
    const amounts = {};
    prizes.filter(p => p.type === 'crypto').forEach(p => {
      const minRaw = host.querySelector(`[data-amin="${p.id}"]`)?.value;
      const maxRaw = host.querySelector(`[data-amax="${p.id}"]`)?.value;
      if (minRaw === '' && maxRaw === '') return; // 都留空 = 不动
      const min = Number(minRaw), max = Number(maxRaw);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0) { toast(`${p.name} 区间下限必须为正数`); throw new Error('abort'); }
      if (max < min) { toast(`${p.name} 上限不能小于下限`); throw new Error('abort'); }
      amounts[p.id] = { min, max };
    });
    try {
      const result = await api('/api/admin/lottery/prize-amounts', { method:'POST', body: JSON.stringify({ amounts }) });
      prizes = result.prizes || prizes;
      toast('✓ 区间已保存并生效');
      renderProb();
    } catch (e) { if (e.message !== 'abort') toast(e.message); }
  }

  async function resetAmount(id) {
    try {
      const result = await api('/api/admin/lottery/prize-amounts', { method:'POST', body: JSON.stringify({ amounts: { [id]: null } }) });
      prizes = result.prizes || prizes;
      toast('✓ 已恢复默认区间');
      renderProb();
    } catch (e) { toast(e.message); }
  }

  // ── 社交审核 ──────────────────────────────────────────────
  async function loadSocial() {
    try {
      const result = await api(`/api/admin/lottery/social?status=${encodeURIComponent(socialStatus)}`);
      socialList = result.list || [];
      if (tab === 'social') renderSocial();
    } catch (e) { toast(e.message); }
  }

  function renderSocial() {
    const host = document.getElementById('al-content');
    if (!host) return;
    host.innerHTML = `
      <div class="al-block">
        <h3>社交推广审核</h3>
        <p class="al-hint">审核用户上传的推特 / 朋友圈推广截图，通过后自动发放积分（每日每平台限 1 次）。</p>
        <div class="al-filter">
          <select id="al-social-status">
            ${['pending', 'approved', 'rejected'].map(s => `<option value="${s}" ${s === socialStatus ? 'selected' : ''}>${STATUS_MAP[s][0]}</option>`).join('')}
          </select>
        </div>
        ${socialList.length ? `<table class="al-table">
          <thead><tr><th>提交时间</th><th>钱包</th><th>平台</th><th>截图</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${socialList.map(s => `<tr>
            <td>${dt(s.createdAt)}</td>
            <td title="${esc(s.wallet)}">${esc(short(s.wallet))}</td>
            <td>${s.platform === 'twitter' ? '推特' : '朋友圈'}</td>
            <td><span class="al-shot" data-shot="${esc(s.id)}">查看截图</span></td>
            <td>${statusBadge(s.status)}</td>
            <td>${s.status === 'pending' ? `
              <button class="al-btn" data-social-approve="${esc(s.id)}">通过</button>
              <button class="al-btn secondary" data-social-reject="${esc(s.id)}">拒绝</button>` : '-'}</td>
          </tr>`).join('')}</tbody>
        </table>` : '<div class="al-empty">暂无记录</div>'}
      </div>`;
    document.getElementById('al-social-status').addEventListener('change', (e) => { socialStatus = e.target.value; loadSocial(); });
    host.querySelectorAll('[data-shot]').forEach(el => el.addEventListener('click', () => {
      const sub = socialList.find(x => x.id === el.dataset.shot);
      if (!sub) return;
      const win = window.open('', '_blank');
      if (win) win.document.write(`<img src="${sub.screenshotUrl}" style="max-width:100%">`);
    }));
    host.querySelectorAll('[data-social-approve]').forEach(el => el.addEventListener('click', () => reviewSocial(el.dataset.socialApprove, true)));
    host.querySelectorAll('[data-social-reject]').forEach(el => el.addEventListener('click', () => reviewSocial(el.dataset.socialReject, false)));
  }

  async function reviewSocial(id, approve) {
    try {
      await api(`/api/admin/lottery/social/${encodeURIComponent(id)}/review`, { method:'POST', body: JSON.stringify({ approve }) });
      toast(approve ? '✓ 已通过并发放积分' : '✓ 已拒绝');
      await loadSocial();
    } catch (e) { toast(e.message); }
  }

  // ── 实物发货 ──────────────────────────────────────────────
  async function loadPhysical() {
    try {
      const result = await api(`/api/admin/lottery/physical?status=${encodeURIComponent(physicalStatus)}`);
      physicalList = result.list || [];
      if (tab === 'physical') renderPhysical();
    } catch (e) { toast(e.message); }
  }

  function parseAddress(payload) {
    try {
      const a = typeof payload === 'string' ? JSON.parse(payload || '{}') : (payload || {});
      return [a.name, a.phone, a.detail].filter(Boolean).join(' · ') || '-';
    } catch { return '-'; }
  }

  function renderPhysical() {
    const host = document.getElementById('al-content');
    if (!host) return;
    host.innerHTML = `
      <div class="al-block">
        <h3>实物奖品发货</h3>
        <p class="al-hint">用户中奖后填写收件地址，确认发货后填写快递单号。</p>
        <div class="al-filter">
          <select id="al-physical-status">
            ${['pending_address', 'pending_ship', 'shipped'].map(s => `<option value="${s}" ${s === physicalStatus ? 'selected' : ''}>${STATUS_MAP[s][0]}</option>`).join('')}
          </select>
        </div>
        ${physicalList.length ? `<table class="al-table">
          <thead><tr><th>时间</th><th>钱包</th><th>奖品</th><th>收件信息</th><th>状态</th><th>快递单号</th></tr></thead>
          <tbody>${physicalList.map(w => `<tr>
            <td>${dt(w.createdAt)}</td>
            <td title="${esc(w.wallet)}">${esc(short(w.wallet))}</td>
            <td>${esc(w.prizeName)}</td>
            <td class="al-addr">${esc(parseAddress(w.addressPayload))}</td>
            <td>${statusBadge(w.status)}</td>
            <td>${w.status === 'pending_ship' ? `
              <input type="text" placeholder="快递单号" data-track="${esc(w.id)}" style="width:130px">
              <button class="al-btn" data-ship="${esc(w.id)}">发货</button>`
              : esc(w.trackingNo || '-')}</td>
          </tr>`).join('')}</tbody>
        </table>` : '<div class="al-empty">暂无记录</div>'}
      </div>`;
    document.getElementById('al-physical-status').addEventListener('change', (e) => { physicalStatus = e.target.value; loadPhysical(); });
    host.querySelectorAll('[data-ship]').forEach(el => el.addEventListener('click', () => shipWin(el.dataset.ship)));
  }

  async function shipWin(id) {
    const trackingNo = document.querySelector(`[data-track="${id}"]`)?.value?.trim();
    if (!trackingNo) { toast('请填写快递单号'); return; }
    try {
      await api(`/api/admin/lottery/physical/${encodeURIComponent(id)}/ship`, { method:'POST', body: JSON.stringify({ trackingNo }) });
      toast('✓ 已标记发货');
      await loadPhysical();
    } catch (e) { toast(e.message); }
  }

  // ── 指定中奖 ──────────────────────────────────────────────
  async function loadAssigned() {
    try {
      const result = await api('/api/admin/lottery/assigned?status=pending');
      assignedList = result.list || [];
      if (tab === 'assigned') renderAssigned();
    } catch (e) { toast(e.message); }
  }

  function renderAssigned() {
    const host = document.getElementById('al-content');
    if (!host) return;
    host.innerHTML = `
      <div class="al-block">
        <h3>指定中奖</h3>
        <p class="al-hint">为指定钱包设置下一次抽奖必中奖品（每个钱包同时只能有一条待生效指定，抽中后自动消耗）。金额留空则按奖品区间随机。</p>
        <div class="al-form">
          <label>钱包地址<input id="al-assign-wallet" placeholder="0x..."></label>
          <label>奖品<select id="al-assign-prize">${prizes.filter(p => p.type !== 'none').map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
          <label>金额（可选）<input id="al-assign-amount" type="number" min="0" step="any" placeholder="留空随机"></label>
          <label>备注<input id="al-assign-note" placeholder="运营活动等"></label>
          <button class="al-btn" id="al-assign-add" style="height:34px">添加指定</button>
        </div>
      </div>
      <div class="al-block">
        <h3>待生效指定（${assignedList.length}）</h3>
        ${assignedList.length ? `<table class="al-table">
          <thead><tr><th>创建时间</th><th>钱包</th><th>奖品</th><th>金额</th><th>备注</th><th>操作</th></tr></thead>
          <tbody>${assignedList.map(a => `<tr>
            <td>${dt(a.createdAt)}</td>
            <td title="${esc(a.wallet)}">${esc(short(a.wallet))}</td>
            <td>${esc(a.prizeName)}</td>
            <td>${a.amount ? Number(a.amount) : '随机'}</td>
            <td>${esc(a.note || '-')}</td>
            <td><button class="al-btn secondary" data-assign-del="${esc(a.id)}">删除</button></td>
          </tr>`).join('')}</tbody>
        </table>` : '<div class="al-empty">暂无待生效指定</div>'}
      </div>`;
    document.getElementById('al-assign-add').addEventListener('click', addAssigned);
    host.querySelectorAll('[data-assign-del]').forEach(el => el.addEventListener('click', () => deleteAssigned(el.dataset.assignDel)));
  }

  async function addAssigned() {
    const wallet = document.getElementById('al-assign-wallet').value.trim();
    const prizeId = document.getElementById('al-assign-prize').value;
    const amount = Number(document.getElementById('al-assign-amount').value) || 0;
    const note = document.getElementById('al-assign-note').value.trim();
    if (!wallet) { toast('请填写钱包地址'); return; }
    try {
      await api('/api/admin/lottery/assigned', { method:'POST', body: JSON.stringify({ wallet, prizeId, amount, note }) });
      toast('✓ 已添加指定中奖');
      document.getElementById('al-assign-wallet').value = '';
      document.getElementById('al-assign-amount').value = '';
      document.getElementById('al-assign-note').value = '';
      await loadAssigned();
    } catch (e) { toast(e.message); }
  }

  async function deleteAssigned(id) {
    try {
      await api(`/api/admin/lottery/assigned/${encodeURIComponent(id)}/delete`, { method:'POST', body: '{}' });
      toast('✓ 已删除');
      await loadAssigned();
    } catch (e) { toast(e.message); }
  }

  // ── 积分充值 ──────────────────────────────────────────────
  function renderTopup() {
    const host = document.getElementById('al-content');
    if (!host) return;
    host.innerHTML = `
      <div class="al-block">
        <h3>给用户充值积分</h3>
        <p class="al-hint">直接为指定钱包增加抽奖积分，立即到账并记录流水。</p>
        <div class="al-form">
          <label>钱包地址<input id="al-topup-wallet" placeholder="0x..."></label>
          <label>积分数量<input id="al-topup-amount" type="number" min="1" step="1" placeholder="例如 100"></label>
          <label>备注<input id="al-topup-note" placeholder="活动补偿 / 运营发放等"></label>
          <button class="al-btn" id="al-topup-add" style="height:34px">确认充值</button>
        </div>
        <div id="al-topup-result" style="margin-top:10px;font-size:13px;color:var(--admin-green,#4fd1b5)"></div>
      </div>`;
    document.getElementById('al-topup-add').addEventListener('click', addTopup);
  }

  async function addTopup() {
    const wallet = document.getElementById('al-topup-wallet')?.value.trim();
    const amount = Number(document.getElementById('al-topup-amount')?.value);
    const note = document.getElementById('al-topup-note')?.value.trim();
    const result = document.getElementById('al-topup-result');
    if (!wallet) { toast('请填写钱包地址'); return; }
    if (!Number.isFinite(amount) || amount <= 0 || Math.floor(amount) !== amount) { toast('积分数量必须为正整数'); return; }
    try {
      const resp = await api('/api/admin/lottery/points', { method:'POST', body: JSON.stringify({ wallet, points: amount, note }) });
      if (result) result.textContent = `✓ 已为 ${short(wallet)} 充值 ${amount} 积分，当前余额 ${resp.balance} 积分`;
      toast('✓ 积分充值成功');
      document.getElementById('al-topup-wallet').value = '';
      document.getElementById('al-topup-amount').value = '';
      document.getElementById('al-topup-note').value = '';
    } catch (e) { toast(e.message); if (result) result.textContent = ''; }
  }

  function init({ api: apiFn, toast: toastFn }) { api = apiFn; toast = toastFn; }
  async function load() {
    if (!api) return;
    renderShell();
    await Promise.all([loadPrizes(), loadSocial(), loadPhysical(), loadAssigned()]);
  }

  return { init, load };
})();
