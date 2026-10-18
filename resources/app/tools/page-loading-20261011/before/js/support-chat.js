// 在线客服（用户端）：钱包登录后与平台客服实时聊天，4s 轮询拉取回复。
(() => {
  const P = window.Portal;
  if (!P) return;

  let pollTimer = null;
  let sending = false;
  let session = null;

  const api = async (path, options = {}) => {
    if (window.currentWalletConnection?.address
      && !window.currentWalletProfile?.authenticated
      && typeof ensurePlatformSession === 'function') {
      try { await ensurePlatformSession(); } catch {}
    }
    const response = await fetch(`/api/support/${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    let payload;
    try { payload = await response.json(); } catch { throw new Error('客服服务暂时不可用，请稍后重试'); }
    if (!response.ok) throw new Error(payload.error || '请求失败，请重试');
    return payload;
  };

  function esc(s) {
    return P.esc ? P.esc(s) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  function fmtTime(ts) {
    return new Date(Number(ts) || Date.now()).toLocaleString('zh-CN', {
      month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false,
    });
  }

  function render() {
    const panel = document.getElementById('tab-support');
    if (!panel) return;
    panel.innerHTML = `<div class="portal-shell">
      ${P.header('在线客服', '7×24 小时在线客服，充值、提现、矿机与交易问题均可在此咨询')}
      <div id="support-chat-content" class="support-chat-wrap">
        <div class="support-chat-loading">正在连接客服…</div>
      </div>
    </div>`;
  }

  function gateHtml() {
    return `<div class="support-chat-gate">${P.walletGate('连接并确认钱包后即可与在线客服对话')}</div>`;
  }

  function chatHtml() {
    const ticket = session?.ticket;
    const closed = ticket?.status === 'closed';
    return `
      <div class="support-chat-card">
        <div class="support-chat-head">
          <div class="support-chat-title">
            <span class="support-chat-avatar">客</span>
            <div>
              <strong>AxiX 在线客服</strong>
              <small id="support-status-line">${closed ? '会话已关闭 · 发送新消息将重新开启' : '<i class="support-online-dot"></i>客服在线 · 通常几分钟内回复'}</small>
            </div>
          </div>
        </div>
        <div class="support-chat-quick">
          <button type="button" data-q="充值不到账怎么办？">充值未到账</button>
          <button type="button" data-q="提现多久能到账？">提现到账时间</button>
          <button type="button" data-q="矿机收益什么时候发放？">矿机收益</button>
          <button type="button" data-q="AIX 交易怎么操作？">AIX 交易</button>
        </div>
        <div class="support-chat-messages" id="support-messages">${messagesHtml()}</div>
        <div class="support-chat-input">
          <textarea id="support-input" rows="1" maxlength="2000" placeholder="请输入您的问题…"></textarea>
          <button type="button" id="support-send" class="portal-button primary">发送</button>
        </div>
      </div>`;
  }

  function messagesHtml() {
    const messages = session?.messages || [];
    if (!messages.length) {
      return '<div class="support-chat-empty">还没有消息，发送下面的常见问题或直接输入您的问题，客服会尽快回复。</div>';
    }
    return messages.map(m => {
      const mine = m.sender === 'user';
      return `<div class="support-msg ${mine ? 'me' : 'them'}">
        <div class="support-msg-bubble">${esc(m.body).replace(/\n/g, '<br>')}</div>
        <div class="support-msg-time">${mine ? '我' : '客服'} · ${fmtTime(m.createdAt)}</div>
      </div>`;
    }).join('');
  }

  function scrollToBottom() {
    const box = document.getElementById('support-messages');
    if (box) box.scrollTop = box.scrollHeight;
  }

  function bindChatEvents() {
    const input = document.getElementById('support-input');
    const sendBtn = document.getElementById('support-send');
    if (!input || !sendBtn) return;
    const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; };
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    sendBtn.addEventListener('click', submit);
    document.querySelectorAll('[data-q]').forEach(btn => {
      btn.addEventListener('click', () => {
        input.value = btn.dataset.q;
        autosize();
        input.focus();
      });
    });
    setTimeout(() => input.focus(), 50);
  }

  async function submit() {
    if (sending) return;
    const input = document.getElementById('support-input');
    const body = String(input?.value || '').trim();
    if (!body) return;
    sending = true;
    const btn = document.getElementById('support-send');
    if (btn) { btn.disabled = true; btn.textContent = '发送中'; }
    try {
      session = await api('message', { method: 'POST', body: JSON.stringify({ body }) });
      input.value = '';
      input.style.height = 'auto';
      paint();
    } catch (e) {
      if (typeof showToast === 'function') showToast(e.message || '发送失败，请重试', 'error');
    } finally {
      sending = false;
      const b = document.getElementById('support-send');
      if (b) { b.disabled = false; b.textContent = '发送'; }
    }
  }

  function paint() {
    const host = document.getElementById('support-chat-content');
    if (!host) return;
    if (!window.currentWalletProfile?.authenticated) {
      host.innerHTML = gateHtml();
      return;
    }
    if (!session) {
      host.innerHTML = '<div class="support-chat-loading">正在连接客服…</div>';
      return;
    }
    // 已有聊天卡片：轮询时只刷新消息区与状态行，保留输入框草稿和焦点
    const card = host.querySelector('.support-chat-card');
    if (card) {
      const box = document.getElementById('support-messages');
      if (box) {
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        box.innerHTML = messagesHtml();
        if (nearBottom) box.scrollTop = box.scrollHeight;
      }
      const status = document.getElementById('support-status-line');
      if (status) {
        const closed = session?.ticket?.status === 'closed';
        status.innerHTML = closed
          ? '会话已关闭 · 发送新消息将重新开启'
          : '<i class="support-online-dot"></i>客服在线 · 通常几分钟内回复';
      }
      return;
    }
    host.innerHTML = chatHtml();
    bindChatEvents();
    scrollToBottom();
  }

  async function refresh({ silent = false } = {}) {
    const authed = window.currentWalletProfile?.authenticated;
    if (!authed) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      paint();
      return;
    }
    try {
      const next = await api('session');
      const prevCount = session?.messages?.length || 0;
      session = next;
      paint();
      // 有客服新消息 → 上报已读
      if ((next.messages?.length || 0) > prevCount
        && next.messages?.some(m => m.sender === 'admin')) {
        api('read', { method: 'POST' }).catch(() => {});
      }
    } catch (e) {
      if (!silent) {
        const host = document.getElementById('support-chat-content');
        if (host) host.innerHTML = `<div class="support-chat-loading">${esc(e.message)}</div>`;
      }
    }
  }

  async function load() {
    render();
    await refresh();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => refresh({ silent: true }), 4000);
  }

  P.register('support', { render, load, fail: () => {
    const h = document.getElementById('support-chat-content');
    if (h) h.innerHTML = P.error('客服服务暂时不可用', "Portal.load('support',true)");
  } });

  // 钱包连接状态变化后刷新门禁/会话
  window.addEventListener('wallet-profile-update', () => {
    const panel = document.getElementById('tab-support');
    if (panel?.classList.contains('active')) refresh();
  });
})();
