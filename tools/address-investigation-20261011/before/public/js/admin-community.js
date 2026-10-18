window.AdminCommunity = (()=>{
  const $=id=>document.getElementById(id);
  const form=$('admin-community-form');
  let api,toast,items=[],revision=null,editing=null,editingRevision=null,busy=false,loading=false,dirty=false;

  // 类型元数据：与前台 community-links.js 图标保持一致
  const ICONS={
    telegram:'<path d="m3 10 18-7-4 18-6-6-4 3 1-7 10-6-8 9Z"/>',
    twitter:'<path d="M4 3h5l11 18h-5ZM20 3 4 21"/>',
    dexbox:'<path d="m12 2 9 5v10l-9 5-9-5V7Zm0 10v10M3 7l9 5 9-5"/>',
    'telegram-support':'<path d="M4 13v-2a8 8 0 0 1 16 0v6a4 4 0 0 1-4 4h-3M4 10H2v7h4v-7Zm14 0h4v7h-4Z"/>',
    qq:'<circle cx="9" cy="8" r="4"/><path d="M2 21v-3a7 7 0 0 1 14 0v3m1-17a4 4 0 0 1 0 8m2 3a5 5 0 0 1 3 5"/>',
    email:'<rect x="2" y="4" width="20" height="16" rx="3"/><path d="m2 6 10 7L22 6"/>',
    ticket:'<path d="M21 11a9 9 0 0 1-9 9H3l1-5a9 9 0 1 1 17-4ZM7 8h10M7 12h7"/>',
  };
  const TYPES=[['telegram','TG'],['twitter','推特'],['dexbox','dexBOX'],['telegram-support','TG客服'],['qq','QQ社群'],['email','邮箱投递'],['ticket','留言工单']];
  const typeLabel=t=>TYPES.find(p=>p[0]===t)?.[1]||t;
  const typeIcon=t=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[t]||ICONS.ticket}</svg>`;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const shortUrl=u=>{ try { const x=new URL(u.startsWith('mailto:')?'http://x/'+u:u); return x.protocol==='mailto:'?u.replace(/^mailto:/i,''):(x.hostname+(x.pathname==='/'?'':x.pathname)); } catch { return u; } };
  const kb=n=>(n/1024).toFixed(0)+' KB';

  function formStatus(message='',error=false){const el=$('admin-community-form-status');el.textContent=message;el.classList.toggle('is-error',error);}
  function setBusy(on){busy=on;form.querySelectorAll('input,select,button').forEach(el=>el.disabled=on);$('admin-community-list').querySelectorAll('button').forEach(el=>el.disabled=on);$('admin-community-presets').querySelectorAll('button').forEach(el=>el.disabled=on);$('admin-community-refresh').disabled=on;}

  function render(result){
    items=result.links||[];revision=result.revision;
    const shown=items.filter(item=>item.enabled&&item.url).length;
    $('admin-community-count').textContent=`共 ${items.length} 个入口 · ${shown} 个前台显示中`;
    $('admin-community-list').innerHTML=items.map((item,index)=>{
      const qr = item.qrcode && /^data:image|^https?:/i.test(item.qrcode)
        ? `<div class="ac-item-qr" title="已配置二维码"><img src="${esc(item.qrcode)}" alt="二维码"><span>扫码图</span></div>` : '';
      const action=(act,label,cls='',disabled='')=>`<button type="button" class="${cls}" data-community-action="${act}" ${disabled}>${label}</button>`;
      return `<article class="admin-community-item" data-link-id="${esc(item.id)}" data-type="${esc(item.type)}">
      <div class="admin-community-item-top">
        <span class="admin-community-badge">${typeIcon(item.type)}</span>
        <div class="ac-item-head"><strong>${esc(item.title)}</strong><small>${esc(typeLabel(item.type))} · 排序 ${item.order}</small></div>
        <span class="admin-status ${item.enabled?'good':''}">${item.enabled?'显示中':'已停用'}</span>
      </div>
      <div class="ac-item-body">
        <div class="ac-item-text">
          <p class="admin-community-destination" title="${esc(item.url||'')}">${esc(item.url?shortUrl(item.url):'未填写地址')}</p>
          ${item.type==='qq'&&item.groupNumber?`<p class="admin-community-description">QQ 群号：<b>${esc(item.groupNumber)}</b></p>`:''}
          ${item.description?`<p class="admin-community-description">${esc(item.description)}</p>`:''}
        </div>
        ${qr}
      </div>
      <div class="admin-community-item-actions">
        ${action('edit','编辑','ac-btn-primary')}
        ${action('toggle',item.enabled?'停用':'启用')}
        ${action('up','↑ 上移','',index===0?'disabled':'')}
        ${action('down','↓ 下移','',index===items.length-1?'disabled':'')}
        ${action('delete','删除','danger')}
      </div>
    </article>`;
    }).join('')||'<div class="admin-empty">还没有社群链接，从上方选择类型添加第一个入口。</div>';
  }

  function hint(){
    const email=$('admin-community-type').value==='email';
    const isQQ=$('admin-community-type').value==='qq';
    $('admin-community-url').placeholder=email?'support@example.com':'https://…';
    $('admin-community-url-hint').textContent=email?'可填写邮箱地址或 mailto: 链接；前台将打开访客的邮件应用。':'填写完整的 http:// 或 https:// 链接。QQ 填写加群链接，留言工单填写工单系统地址。';
    $('admin-community-url').required=$('admin-community-enabled').checked;
    document.querySelectorAll('.admin-community-qq-group').forEach(el=>{el.style.display=isQQ?'':'none';});
    $('admin-community-group-number').required=false;
  }
  function clearQR(){
    $('admin-community-qrcode').value='';
    $('admin-community-qrcode-data').value='';
    const p=$('admin-community-qrcode-preview');
    p.innerHTML='';p.style.display='none';
  }
  function setQR(dataUrl,meta=''){
    $('admin-community-qrcode-data').value=dataUrl||'';
    const p=$('admin-community-qrcode-preview');
    if(!dataUrl){p.innerHTML='';p.style.display='none';return;}
    p.innerHTML=`<img src="${dataUrl}" alt="二维码预览"><div class="admin-community-qr-meta"><span>已生成可保存的二维码</span>${meta?`<small>${esc(meta)}</small>`:''}<button type="button" id="admin-community-qrcode-clear" class="admin-community-qr-clear">移除图片</button></div>`;
    p.style.display='flex';
    p.querySelector('#admin-community-qrcode-clear').addEventListener('click',clearQR);
  }
  function reset(type='telegram'){
    form.reset();editing=null;editingRevision=null;dirty=false;clearQR();
    $('admin-community-type').value=type;
    $('admin-community-title').value=typeLabel(type);
    $('admin-community-order').value=Math.min(9999,items.length?Math.max(...items.map(item=>item.order))+10:0);
    $('admin-community-editor-title').innerHTML=`<span class="ac-editor-icon">${typeIcon(type)}</span>添加链接`;
    $('admin-community-save').textContent='添加链接';$('admin-community-cancel').textContent='清空表单';formStatus();hint();
  }
  async function mayReplace(){return !dirty||await confirmDialog('表单有未保存的修改，确认放弃这些修改？');}
  async function load(){
    if(!api||loading||busy)return;
    loading=true;$('admin-community-refresh').disabled=true;
    $('admin-community-list-status').textContent='正在读取社群链接…';
    try{const result=await api('/api/admin/community-links');render(result);$('admin-community-list-status').textContent='';if(!editing&&!dirty)$('admin-community-order').value=Math.min(9999,items.length?Math.max(...items.map(item=>item.order))+10:0);}
    catch(error){$('admin-community-list-status').textContent=error.message;}
    finally{loading=false;$('admin-community-refresh').disabled=false;}
  }
  async function edit(item){
    if(!await mayReplace())return;
    editing=item.id;editingRevision=revision;dirty=false;
    for(const key of ['type','title','url','description','order'])$(`admin-community-${key}`).value=item[key];
    $('admin-community-group-number').value=item.groupNumber||'';
    $('admin-community-enabled').checked=item.enabled;
    setQR(item.qrcode||'', item.qrcode&&item.qrcode.startsWith('data:')?`原图约 ${kb(Math.round(item.qrcode.length*0.75))}`:'');
    $('admin-community-editor-title').innerHTML=`<span class="ac-editor-icon">${typeIcon(item.type)}</span>编辑链接`;
    $('admin-community-save').textContent='保存修改';$('admin-community-cancel').textContent='取消编辑';formStatus();hint();
    form.scrollIntoView({behavior:'smooth',block:'start'});$('admin-community-title').focus({preventScroll:true});
  }
  async function save(event){
    event.preventDefault();if(busy)return;
    if(revision===null){formStatus('请先刷新列表，读取配置后再保存。',true);return;}
    const qrcode=$('admin-community-qrcode-data').value;
    if(qrcode.length>2_000_000){formStatus('二维码图片仍过大，请重新选择一张更清晰的小图片。',true);return;}
    const body={revision:editing?editingRevision:revision,type:$('admin-community-type').value,title:$('admin-community-title').value.trim(),url:$('admin-community-url').value.trim(),groupNumber:$('admin-community-group-number').value.trim(),description:$('admin-community-description').value.trim(),qrcode,order:Number($('admin-community-order').value),enabled:$('admin-community-enabled').checked};
    const type=body.type;setBusy(true);formStatus('正在保存…');
    try{
      const result=await api(`/api/admin/community-links${editing?'/'+encodeURIComponent(editing):''}`,{method:editing?'PUT':'POST',body:JSON.stringify(body)});
      render(result);reset(type);formStatus('已保存，前台链接已更新。');toast('社群链接已保存');
    }catch(error){formStatus(error.message,true);}
    finally{setBusy(false);render({links:items,revision});}
  }
  async function action(event){
    const button=event.target.closest('[data-community-action]');if(!button||busy)return;
    const item=items.find(item=>item.id===button.closest('[data-link-id]')?.dataset.linkId);if(!item)return;
    const action=button.dataset.communityAction;
    if(action==='edit'){edit(item);return;}
    if(dirty){formStatus('请先保存或清空表单中的修改，再操作列表。',true);form.scrollIntoView({behavior:'smooth'});return;}
    if(action==='delete'&&!await confirmDialog(`确定删除「${item.title}」？删除后前台入口将消失。`))return;
    setBusy(true);$('admin-community-list-status').textContent='正在更新…';
    try{
      let result;
      if(action==='up'||action==='down'){
        const ids=items.map(item=>item.id),i=ids.indexOf(item.id),target=i+(action==='up'?-1:1);
        if(target<0||target>=ids.length)return;
        [ids[i],ids[target]]=[ids[target],ids[i]];
        result=await api('/api/admin/community-links/reorder',{method:'POST',body:JSON.stringify({ids,revision})});
      }else result=await api('/api/admin/community-links/'+encodeURIComponent(item.id),{method:action==='delete'?'DELETE':'PUT',body:JSON.stringify(action==='delete'?{revision}:{...item,revision,enabled:!item.enabled})});
      render(result);if(editing===item.id)reset();$('admin-community-list-status').textContent='已更新';
    }catch(error){$('admin-community-list-status').textContent=error.message;}
    finally{setBusy(false);render({links:items,revision});}
  }

  // ── 二维码客户端压缩：原图可能数 MB，超过接口 32KB 旧限制导致保存失败 ──
  // 统一缩放到 ≤512px、铺白底、优先 PNG（二维码锐利且体积小），过大再回退 JPEG
  function fileToCompressedDataURL(file){
    return new Promise((resolve,reject)=>{
      const reader=new FileReader();
      reader.onerror=()=>reject(new Error('图片读取失败，请重试'));
      reader.onload=()=>{
        const img=new Image();
        img.onload=()=>{
          const MAX=512;
          const scale=Math.min(1,MAX/Math.max(img.naturalWidth,img.naturalHeight));
          const w=Math.max(1,Math.round(img.naturalWidth*scale));
          const h=Math.max(1,Math.round(img.naturalHeight*scale));
          const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
          const ctx=canvas.getContext('2d');
          ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);
          ctx.drawImage(img,0,0,w,h);
          let url=canvas.toDataURL('image/png');
          if(url.length>400_000) url=canvas.toDataURL('image/jpeg',0.9);
          resolve({url,width:w,height:h,bytes:Math.round(url.length*0.75)});
        };
        img.onerror=()=>reject(new Error('图片格式不支持，请选择 PNG / JPG / WEBP'));
        img.src=reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function init(dependencies){
    api=dependencies.api;toast=dependencies.toast;
    $('admin-community-presets').innerHTML=TYPES.map(([type,label])=>`<button type="button" data-community-preset="${type}"><span class="ac-preset-icon">${typeIcon(type)}</span>${label}</button>`).join('');
    $('admin-community-presets').addEventListener('click',async event=>{const b=event.target.closest('[data-community-preset]');if(b&&await mayReplace()){reset(b.dataset.communityPreset);$('admin-community-url').focus();}});
    form.addEventListener('input',()=>{dirty=true;});form.addEventListener('change',()=>{dirty=true;hint();});form.addEventListener('submit',save);
    $('admin-community-cancel').addEventListener('click',async ()=>{if(await mayReplace())reset();});
    $('admin-community-refresh').addEventListener('click',async ()=>{if(await mayReplace()){reset();load();}});
    $('admin-community-list').addEventListener('click',action);
    // 二维码：自动压缩后再放入表单（原图 ≤5MB 均可，压缩后通常 20~150KB，保证能保存）
    $('admin-community-qrcode').addEventListener('change',async e=>{
      const file=e.target.files[0];
      if(!file)return;
      if(!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)){formStatus('请选择 PNG / JPG / WEBP 格式的二维码图片',true);$('admin-community-qrcode').value='';return;}
      if(file.size>8*1024*1024){formStatus('原图不能超过 8MB（系统会自动压缩为小图）',true);return;}
      formStatus('正在压缩二维码…');
      try{
        const r=await fileToCompressedDataURL(file);
        setQR(r.url,`压缩后 ${r.width}×${r.height} · 约 ${kb(r.bytes)}`);
        dirty=true;formStatus(r.bytes>2_000_000?'压缩后仍偏大，请换一张更简单的二维码':'二维码已就绪，保存后生效');
      }catch(err){formStatus(err.message,true);}
    });
    reset();
  }
  return {init,load};
})();
