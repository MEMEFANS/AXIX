(() => {
  const grid=document.getElementById('community-links-grid');
  if(!grid) return;
  const status=document.getElementById('community-status');
  const refresh=document.getElementById('community-refresh');
  const icons={
    telegram:'<path d="m3 10 18-7-4 18-6-6-4 3 1-7 10-6-8 9Z"/>',
    twitter:'<path d="M4 3h5l11 18h-5ZM20 3 4 21"/>',
    dexbox:'<path d="m12 2 9 5v10l-9 5-9-5V7Zm0 10v10M3 7l9 5 9-5"/>',
    'telegram-support':'<path d="M4 13v-2a8 8 0 0 1 16 0v6a4 4 0 0 1-4 4h-3M4 10H2v7h4v-7Zm14 0h4v7h-4Z"/>',
    qq:'<circle cx="9" cy="8" r="4"/><path d="M2 21v-3a7 7 0 0 1 14 0v3m1-17a4 4 0 0 1 0 8m2 3a5 5 0 0 1 3 5"/>',
    email:'<rect x="2" y="4" width="20" height="16" rx="3"/><path d="m2 6 10 7L22 6"/>',
    ticket:'<path d="M21 11a9 9 0 0 1-9 9H3l1-5a9 9 0 1 1 17-4ZM7 8h10M7 12h7"/>',
  };
  let pending=false;
  // 群号码一键复制（事件委托，兼容二维码/普通两种卡片）
  grid.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy-group]');
    if (!btn) return;
    e.preventDefault();
    const num = btn.getAttribute('data-copy-group');
    const done = async (text) => {
      try { await navigator.clipboard.writeText(text); return true; } catch {}
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch { return false; }
    };
    const ok = await done(num);
    const orig = btn.textContent;
    btn.textContent = ok ? '已复制群号 ✓' : '请长按复制';
    setTimeout(() => { btn.textContent = orig; }, 1600);
  });
  function groupNumberHtml(item) {
    const num = String(item.groupNumber || '').trim();
    if (!num) return '';
    return `<div class="community-qq-group">
      <span class="community-qq-group-label">QQ 群号</span>
      <b class="community-qq-group-num" data-no-translate>${num}</b>
      <span role="button" tabindex="0" class="community-qq-group-copy" data-copy-group="${num}">复制群号</span>
    </div>`;
  }
  function render(items) {
    grid.replaceChildren();
    if(!items.length) {
      grid.innerHTML='<div class="community-empty"><span aria-hidden="true">↗</span><h3>社群入口即将开放</h3><p>链接发布后将在这里显示，欢迎稍后回来查看。</p></div>';
      return;
    }
    for(const item of items) {
      const isQQ = item.type === 'qq';
      const hasQR = isQQ && item.qrcode;

      if (hasQR) {
        // QQ 带二维码 — 显示二维码卡片
        const card = document.createElement('div');
        card.className='community-link community-link--qr';
        card.dataset.type=item.type;
        card.innerHTML=`
          <span class="community-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[item.type]||icons.ticket}</svg></span>
          <div class="community-link-copy">
            <strong data-no-translate></strong>
            <span class="community-link-description" data-no-translate></span>
            <small class="community-link-qr-hint">扫码加入</small>
            <div class="community-qq-group-slot"></div>
          </div>
          <div class="community-qrcode-box">
            <img class="community-qrcode-img" alt="QQ群二维码" />
            <a class="community-link-qr-fallback" target="_blank" rel="noopener noreferrer">打开加群链接 →</a>
          </div>`;
        card.querySelector('strong').textContent=item.title;
        card.querySelector('.community-link-description').textContent=item.description;
        card.querySelector('.community-qq-group-slot').innerHTML=groupNumberHtml(item);
        card.querySelector('.community-qrcode-img').src=item.qrcode;
        const fallback = card.querySelector('.community-link-qr-fallback');
        fallback.href = item.url;
        grid.append(card);
      } else {
        // 普通链接 — 可点击跳转
        let target;
        try{target=new URL(item.url);}catch{continue;}
        if(!['https:','http:','mailto:'].includes(target.protocol))continue;
        const link=document.createElement('a');
        link.className='community-link';
        link.href=target.href;
        link.dataset.type=item.type;
        if(target.protocol!=='mailto:'){link.target='_blank';link.rel='noopener noreferrer';}
        link.innerHTML=`<span class="community-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[item.type]||icons.ticket}</svg></span><span class="community-link-copy"><strong data-no-translate></strong><span class="community-link-description" data-no-translate></span><small data-no-translate></small><span class="community-qq-group-slot"></span></span><span class="community-link-arrow" aria-hidden="true">↗</span>`;
        link.querySelector('strong').textContent=item.title;
        link.querySelector('.community-link-description').textContent=item.description;
        link.querySelector('small').textContent=target.protocol==='mailto:'?target.pathname:target.hostname;
        link.querySelector('.community-qq-group-slot').innerHTML=groupNumberHtml(item);
        grid.append(link);
      }
    }
  }
  async function load() {
    if(pending)return;
    pending=true;refresh.disabled=true;grid.setAttribute('aria-busy','true');status.textContent='正在读取社群链接…';
    try {
      const response=await fetch('/api/community-links',{cache:'no-store',signal:AbortSignal.timeout(12000)});
      if(!response.ok)throw new Error('社群链接暂时无法加载，请点击「刷新链接」重试。');
      const data=await response.json();
      if(!Array.isArray(data.links))throw new Error('链接数据暂不可用，请稍后重试。');
      render(data.links);status.textContent='';
    } catch(error) {status.textContent=error.name==='TimeoutError'?'加载超时，请点击「刷新链接」重试。':error.message;}
    finally{pending=false;refresh.disabled=false;grid.setAttribute('aria-busy','false');}
  }
  refresh.addEventListener('click',load);
  window.CommunityLinks={load};
  if(new URLSearchParams(location.search).get('page')==='community')switchTab('community');
})();
