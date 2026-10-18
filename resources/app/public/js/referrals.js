(() => {
  const P = Portal;
  let referralLink = '';
  const request = async (path, options) => {
    if (!options?.method || options.method === 'GET') return P.readJSON(`/api/referrals/${path}`, options);
    const response = await fetch(`/api/referrals/${path}`, options);
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error('推荐服务暂时不可用，请稍后重试'); }
    if (!response.ok) throw new Error(payload.error || '推荐数据加载失败');
    return payload;
  };
  window.copyReferralLink = async () => {
    if (!referralLink) return;
    // copyTextSmart:Clipboard API 不可用/被拒时降级 execCommand,兼容老手机 WebView
    const ok = await window.copyTextSmart?.(referralLink);
    if (ok) showToast('推荐链接已复制', 'ok');
    else {
      await promptDialog('请长按链接全选复制', referralLink);
    }
  };
  window.claimReferralRewards = async (button) => {
    if (button) { button.disabled = true; button.textContent = '领取中…'; }
    try {
      const result = await request('claim', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:'{}' });
      showToast(result.count ? `已领取 ${Number(result.amount || 0).toFixed(2)} USDT` : '暂无可领取奖励', 'ok');
      await P.load('referrals', true);
    } catch (error) {
      showToast(error.message || '领取失败', 'error');
      if (button) { button.disabled = false; button.textContent = '立即领取'; }
    }
  };
  function render() {
    document.getElementById('tab-referrals').innerHTML = `<div class="portal-shell">${P.header('推荐', '邀请用户使用平台交易和合约跟单')}<div id="referrals-content">${P.walletGate('连接钱包后查看推荐链接与奖励')}</div></div>`;
  }
  async function load(context = { isCurrent:() => true }) {
    const host = document.getElementById('referrals-content');
    if (!window.currentWalletProfile?.authenticated && window.currentWalletConnection?.address
      && typeof ensurePlatformSession === 'function') await ensurePlatformSession();
    if (!context.isCurrent()) return;
    if (!window.currentWalletProfile?.authenticated) {
      host.innerHTML = P.walletGate('连接并确认钱包后查看推荐数据');
      return;
    }
    host.innerHTML = P.loading(6);
    // 绑定兜底：URL ?ref= 优先，其次登录时暂存的推荐码（wallet.js 存入，绑定成功后清除）
    const pendingCode = new URLSearchParams(location.search).get('ref') || localStorage.getItem('wg_referral_code') || '';
    let data;
    if (pendingCode) {
      try {
        data = await request('bind', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ code:pendingCode }) });
        localStorage.removeItem('wg_referral_code');
      } catch { data = await request('profile'); }   // 绑定失败（如码无效）→ 正常展示推荐数据
    } else {
      data = await request('profile');
    }
    if (!context.isCurrent()) return;
    referralLink = `${location.origin}${data.link}`;
    // API 字段在冷启动或旧版本后端下可能缺省；统一归一化，避免页面出现
    // “undefined 人 / NaN%”这类不专业的空状态。
    const directValid = Number.isFinite(Number(data.directValid)) ? Number(data.directValid) : 0;
    const directInvalid = Number.isFinite(Number(data.directInvalid)) ? Number(data.directInvalid) : 0;
    const directRate = Number.isFinite(Number(data.directRate)) ? Number(data.directRate) : 0;
    const earned = Number.isFinite(Number(data.earned)) ? Number(data.earned) : 0;
    const claimable = Number.isFinite(Number(data.claimable)) ? Number(data.claimable) : 0;
    // 仅展示直推用户（间推已废弃）
    const directRows = (data.rows || []).filter(item => item.level === 1);
    // data-label values are used by the mobile card layout (the table header is
    // hidden below 480px, so each value keeps its meaning through the label).
    const rows = directRows.map(item => {
      const joined = item.joinedAt ? new Date(item.joinedAt) : null;
      const joinedText = joined && !Number.isNaN(joined.getTime()) ? joined.toLocaleDateString('zh-CN') : '—';
      const n = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US') : '0';
      // 跟单金额为 USDT 本金，固定两位小数展示
      const n2 = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }) : '0.00';
      return `<tr class="referral-row"><td data-label="钱包地址">${P.esc(item.shortAddress || item.wallet || '—')}</td><td data-label="关系">直接推荐</td><td data-label="加入日期">${joinedText}</td><td data-label="总交易量">${n(item.totalVolume)} USDT</td><td data-label="总费用">${n(item.totalFees)} USDT</td><td data-label="跟单金额">${n2(item.managedAmount)} USDT</td><td data-label="您的奖励" class="portal-positive">${n(item.myReward)} USDT</td><td data-label="状态"><span class="${item.valid ? 'portal-positive' : 'portal-muted'}">${item.valid ? '有效' : '无效'}</span></td></tr>`;
    }).join('');
    host.innerHTML = `<div class="portal-metrics">${P.metric('有效直推', `${directValid} 人`)}${P.metric('无效直推', `${directInvalid} 人`)}${P.metric('获得的奖励', P.money(earned))}${P.metric('可领取的奖励', `${P.money(claimable)}${claimable > 0 ? '<button type="button" class="portal-button primary referral-claim-btn" onclick="claimReferralRewards(this)">立即领取</button>' : ''}`)}</div><p class="referral-claim-hint">推荐奖励进入可领取余额后，由你点击"立即领取"发放到平台 USDT 余额。</p>
      <div class="portal-section"><div class="portal-section-head"><h2>我的推荐链接</h2><span>直推 ${(directRate*100).toFixed(0)}%</span></div><div class="referral-link-body"><code class="referral-link-code">${P.esc(referralLink)}</code><button type="button" class="portal-button primary referral-copy-btn" onclick="copyReferralLink()">复制链接</button></div></div>
      <div class="portal-section"><div class="portal-section-head"><h2>推荐用户</h2><span>有效 ${directValid} · 无效 ${directInvalid}</span></div><div class="portal-table-wrap referrals-table-wrap"><table class="portal-table referrals-table"><thead><tr><th>钱包地址</th><th>关系</th><th>加入日期</th><th>总交易量</th><th>总费用</th><th>跟单金额</th><th>您的奖励</th><th>状态</th></tr></thead><tbody>${rows || '<tr><td colspan="8">暂无推荐用户</td></tr>'}</tbody></table></div></div>${airdropSectionHtml()}`;
    loadAirdropBoard();
  }
  P.register('referrals', { render, load, fail:error => { document.getElementById('referrals-content').innerHTML = P.error(error.message, "Portal.load('referrals',true)"); } });

  // ── 交易空投积分（独立账本，仅空投凭证，不能抽奖） ──────────────
  const AIRDROP_FLOW_META = {
    spot_trade:    { icon: '💱', label: '现货交易' },
    perp_trade:    { icon: '📈', label: '合约交易' },
    copy_trade:    { icon: '🤖', label: 'AI跟单收益' },
    wash_filtered: { icon: '🧹', label: '刷量剔除' },
  };
  function airdropSectionHtml() {
    return `<div class="portal-section"><div class="portal-section-head"><h2>🪂 交易空投积分</h2><button type="button" class="portal-button" onclick="openAirdropModal()">明细</button></div>
      <div class="portal-metrics" id="airdrop-metrics"><div style="font-size:12px;color:#81918e">加载中...</div></div>
      <p class="referral-claim-hint">积分规则：现货/合约有效成交量每 1,000 USDT 计 1 积分，AI 跟单结算收益每 10 USDT 计 1 积分；每周一结算上周积分，对倒刷量双向剔除不计分。积分独立于抽奖积分，仅用于后续空投。</p></div>`;
  }
  async function loadAirdropBoard() {
    const wallet = P.walletKey();
    const host = document.getElementById('airdrop-metrics');
    if (!host) return;
    if (!window.currentWalletProfile?.authenticated) { host.innerHTML = '<div style="font-size:12px;color:#81918e">连接钱包后查看空投积分</div>'; return; }
    try {
      const pts = await P.readJSON('/api/airdrop/points');
      if (wallet !== P.walletKey() || !host.isConnected) return;
      const cw = pts.currentWeek || {};
      host.innerHTML = [
        P.metric('空投积分余额', Number(pts.points || 0).toLocaleString()),
        P.metric('上周结算', `+${Number(pts.lastWeekPoints || 0).toLocaleString()}`),
        P.metric('本周预估积分', `≈ ${Number(cw.estPoints || 0).toLocaleString()}`),
        P.metric('已剔除刷量', `${Number(cw.washVolume || 0).toLocaleString()} USDT`),
      ].join('');
    } catch { host.innerHTML = '<div style="font-size:12px;color:#81918e">空投积分加载失败，请稍后重试</div>'; }
  }
  window.openAirdropModal = async function() {
    if (!window.currentWalletProfile?.authenticated) { showToast('请先连接钱包', 'error'); return; }
    const mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(4,9,11,.74);display:flex;align-items:center;justify-content:center;padding:16px';
    mask.innerHTML = `
      <div style="width:min(520px,94vw);max-height:82vh;overflow:auto;background:#0e1719;border:1px solid rgba(116,192,252,.35);border-radius:14px;padding:16px 18px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h3 style="margin:0;font-size:16px;color:#e7f1ef">🪂 交易空投积分</h3>
          <button type="button" class="airdrop-modal-close" style="background:none;border:none;color:#81918e;font-size:18px;cursor:pointer;padding:4px">✕</button>
        </div>
        <div class="airdrop-modal-body" style="font-size:13px;color:#cfd8d6">加载中...</div>
      </div>`;
    const close = () => mask.remove();
    mask.addEventListener('click', e => { if (e.target === mask) close(); });
    mask.querySelector('.airdrop-modal-close').addEventListener('click', close);
    document.body.appendChild(mask);
    try {
      const [ptsRes, flowsRes] = await Promise.all([fetch('/api/airdrop/points'), fetch('/api/airdrop/flows?limit=50')]);
      if (!ptsRes.ok) throw new Error('load failed');
      const pts = await ptsRes.json();
      const flows = flowsRes.ok ? (await flowsRes.json()).flows : [];
      const cw = pts.currentWeek || {};
      mask.querySelector('.airdrop-modal-body').innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:linear-gradient(135deg,rgba(116,192,252,.12),rgba(116,192,252,.03));border:1px solid rgba(116,192,252,.3);border-radius:12px">
          <div><div style="font-size:12px;color:#81918e">空投积分余额（已结算）</div><b style="font-size:22px;color:#74c0fc">${Number(pts.points || 0).toLocaleString()}</b></div>
          <div style="text-align:right"><div style="font-size:12px;color:#81918e">上周结算</div><b style="font-size:15px;color:#e7f1ef">+${Number(pts.lastWeekPoints || 0).toLocaleString()}</b></div>
        </div>
        <div style="margin-top:12px;padding:10px 14px;border:1px dashed rgba(116,192,252,.25);border-radius:12px;font-size:12px;color:#81918e">
          <div style="font-weight:600;color:#74c0fc;margin-bottom:6px">本周进行中（${pts.week || ''}）</div>
          <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>现货有效成交量</span><b style="color:#e7f1ef">${Number(cw.spotVolume || 0).toLocaleString()} USDT</b></div>
          <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>合约有效成交量</span><b style="color:#e7f1ef">${Number(cw.perpVolume || 0).toLocaleString()} USDT</b></div>
          <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>AI 跟单结算收益</span><b style="color:#e7f1ef">${Number(cw.copyProfit || 0).toLocaleString()} USDT</b></div>
          <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>已剔除刷量</span><b style="color:#e8463a">-${Number(cw.washVolume || 0).toLocaleString()} USDT</b></div>
          <div style="display:flex;justify-content:space-between"><span>预估积分（周一结算后到账）</span><b style="color:#74c0fc">≈ ${Number(cw.estPoints || 0).toLocaleString()}</b></div>
        </div>
        <div style="margin-top:12px">${airdropFlowsHtml(flows)}</div>
        <p style="margin:12px 0 0;font-size:12px;color:#81918e;line-height:1.6">积分规则：每周一结算上周积分（每 1,000 USDT 有效成交量 = 1 积分，AI 跟单结算收益每 10 USDT = 1 积分）；对倒刷量双向剔除不计分；积分独立于抽奖积分，仅用于后续空投。</p>`;
    } catch {
      const body = mask.querySelector('.airdrop-modal-body');
      if (body) body.textContent = '加载失败，请稍后再试';
    }
  };
  function airdropFlowsHtml(flows) {
    if (!flows || !flows.length) return '<div style="padding:16px;text-align:center;font-size:12px;color:#5a6b68">暂无空投积分记录 · 交易现货/合约或开启 AI 跟单即可累计</div>';
    return flows.map(f => {
      const meta = AIRDROP_FLOW_META[f.type] || { icon: '•', label: f.note || '积分变动' };
      const pos = Number(f.change) >= 0;
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 2px;border-bottom:1px solid rgba(255,255,255,.06)">
        <div style="display:flex;gap:9px;align-items:center;min-width:0">
          <span style="font-size:16px">${meta.icon}</span>
          <div style="min-width:0"><div style="font-size:13px;color:#e7f1ef">${meta.label}</div>
          <div style="font-size:11px;color:#81918e">${new Date(f.createdAt).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })} · ${f.week || ''}</div></div>
        </div>
        <b style="color:${pos ? '#50d2c2' : '#e8463a'};flex-shrink:0">${pos ? '+' : ''}${Number(f.change).toLocaleString()}</b>
      </div>`;
    }).join('');
  }
})();
