// Retain Chinese sources: language switches must never reverse-translate a translation.
window.I18n = (() => {
  const KEY='trade-lang';
  const LANGS=[['zh','简体中文'],['zh-TW','繁體中文'],['en','English'],['ja','日本語'],['ko','한국어'],['ru','Русский'],['es','Español']];
  const ATTRS=['placeholder','title','aria-label','alt','data-label'];
  const EXCLUDE='script,style,noscript,code,pre,[data-no-translate],#lang-menu';
  const sources=new WeakMap(),attrSources=new WeakMap(),maps=new Map(),loads=new Map();
  let current='zh',observer,timer,revision=0;
  const escapeRe=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  function loadScript(file,ready) {
    if(ready())return Promise.resolve();
    if(loads.has(file))return loads.get(file);
    const promise=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src='/js/'+file+'?v=20261017-rules-1';
      script.onload=()=>ready()?resolve():reject(new Error('Invalid translation dictionary: '+file));
      script.onerror=()=>reject(new Error('Unable to load translation dictionary: '+file));
      document.head.appendChild(script);
    });
    loads.set(file,promise);
    promise.catch(()=>loads.delete(file));
    return promise;
  }
  async function ensure(lang) {
    if(lang==='zh')return;
    await loadScript('i18n-zh-en.js',()=>!!window.I18nDict);
    if(lang!=='en')await loadScript('i18n-extra.js',()=>!!window.I18nExtra);
  }
  function mapFor(lang) {
    if(maps.has(lang))return maps.get(lang);
    const values=Object.assign({},window.I18nDict,window.I18nExtra?.[lang]);
    // Template fragments are code, not display text.
    const keys=Object.keys(values).filter(k=>k&&!/<\/?[a-z][^>]*>/i.test(k)).sort((a,b)=>b.length-a.length);
    const fragments=keys.filter(k=>k.trim().length>1||k!==k.trim());
    const regex=fragments.length?new RegExp(fragments.map(escapeRe).join('|'),'g'):null;
    const templates=Object.entries(window.I18nPatterns?.[lang]||{}).map(([source,target])=>{
      const names=[];
      const parts=source.split(/(\{\{\w+\}\})/);
      const pattern=parts.map(part=>{
        if(/^\{\{\w+\}\}$/.test(part)){names.push(part.slice(2,-2));return '([\\s\\S]+?)';}
        return escapeRe(part);
      }).join('');
      return {regex:new RegExp('^'+pattern+'$'),names,target};
    });
    const map={values,regex,templates};maps.set(lang,map);return map;
  }
  function translate(source,element,lang=current) {
    if(!source||lang==='zh')return source;
    const map=mapFor(lang),trimmed=source.trim();
    if(lang==='en'&&trimmed==='有效期'&&element?.closest('#trade-tif-field'))return source.replace(trimmed,'Time in Force');
    if(Object.hasOwn(map.values,trimmed))return source.replace(trimmed,map.values[trimmed]);
    const prefix=trimmed.match(/^[^\p{L}\p{N}]+/u)?.[0]||'';
    for(const template of map.templates){
      const match=template.regex.exec(trimmed.slice(prefix.length));
      if(match){
        const target=template.target.replace(/\{\{(\w+)\}\}/g,(_,name)=>translate(match[template.names.indexOf(name)+1],element,lang));
        return source.replace(trimmed,prefix+target);
      }
    }
    if(!map.regex||!/[\u4e00-\u9fff]/.test(source))return source;
    map.regex.lastIndex=0;
    return source.replace(map.regex,key=>map.values[key]);
  }
  function textNode(node) {
    const el=node.parentElement;if(!el||el.closest(EXCLUDE))return;
    const live=node.nodeValue;
    let record=sources.get(node);
    // An application write establishes a fresh source, including new amounts.
    if(!record||live!==record.rendered){
      record=record?.history?.has(live)?{source:record.history.get(live),rendered:live,history:record.history}:{source:live,rendered:live,history:new Map()};
    }
    const source=el.hasAttribute('data-nav-zh')?el.dataset.navZh:record.source;
    record.rendered=translate(source,el);record.history.set(record.rendered,source);sources.set(node,record);
    if(live!==record.rendered)node.nodeValue=record.rendered;
  }
  function attributes(el) {
    if(el.closest(EXCLUDE))return;
    let records=attrSources.get(el);if(!records){records={};attrSources.set(el,records);}
    for(const attr of ATTRS){
      if(!el.hasAttribute(attr)){delete records[attr];continue;}
      const live=el.getAttribute(attr);let record=records[attr];
      if(!record||live!==record.rendered)record={source:live,rendered:live};
      record.rendered=translate(record.source,el);records[attr]=record;
      if(live!==record.rendered)el.setAttribute(attr,record.rendered);
    }
  }
  function apply() {
    if(!document.body)return;
    observer?.disconnect();
    try{
      const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
      while(walker.nextNode())textNode(walker.currentNode);
      document.querySelectorAll(ATTRS.map(a=>'['+a+']').join(',')).forEach(attributes);
      const title=document.querySelector('title');
      if(title?.firstChild){
        const node=title.firstChild,live=node.nodeValue;let record=sources.get(node);
        if(!record||live!==record.rendered)record={source:live,rendered:live};
        record.rendered=translate(record.source,title);sources.set(node,record);
        if(live!==record.rendered)node.nodeValue=record.rendered;
      }
      document.documentElement.lang=current==='zh'?'zh-CN':current;
    }finally{
      observer?.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:ATTRS});
    }
  }
  async function set(lang) {
    if(!LANGS.some(([code])=>code===lang))lang='zh';
    const request=++revision;
    try{await ensure(lang);}catch(error){console.error('[i18n]',error);return false;}
    if(request!==revision)return false;
    current=lang;try{localStorage.setItem(KEY,lang);}catch{}
    apply();window.dispatchEvent(new CustomEvent('languagechange',{detail:{lang}}));return true;
  }
  async function init() {
    if(!observer){
      observer=new MutationObserver(mutations=>{
        // Chinese is the source language: live clocks/amounts need no translation or full DOM scan.
        if(current==='zh')return;
        if(!mutations.some(m=>!((m.target.nodeType===Node.ELEMENT_NODE?m.target:m.target.parentElement)?.closest(EXCLUDE))))return;
        if(timer)clearTimeout(timer);timer=setTimeout(()=>{timer=null;apply();},50);
      });
    }
    apply();let saved='zh';try{saved=localStorage.getItem(KEY)||'zh';}catch{}
    await set(saved);
  }
  return {set,init,apply,t:source=>translate(source),toggle:()=>set(current==='zh'?'en':'zh'),langs:LANGS,get current(){return current;}};
})();
document.addEventListener('DOMContentLoaded',()=>{
  window.I18n.init();
  const button=document.getElementById('lang-toggle');if(!button)return;
  button.textContent='🌐';button.onclick=null;
  button.addEventListener('click',event=>{
    event.stopPropagation();const old=document.getElementById('lang-menu');if(old){old.remove();return;}
    const menu=document.createElement('div');menu.id='lang-menu';menu.dataset.noTranslate='';
    menu.style.cssText='position:fixed;background:var(--panel,#16201d);border:1px solid var(--border,#1f2a26);border-radius:10px;padding:6px 0;z-index:9999;min-width:160px;box-shadow:0 8px 28px rgba(0,0,0,.5);overflow:hidden';
    const rect=button.getBoundingClientRect();menu.style.top=(rect.bottom+6)+'px';menu.style.right=Math.max(8,innerWidth-rect.right)+'px';
    for(const [code,label]of window.I18n.langs){
      const item=document.createElement('button');item.type='button';item.textContent=(code===window.I18n.current?'✓ ':'　')+label;
      item.style.cssText='display:block;width:100%;padding:8px 16px;border:0;background:transparent;color:'+(code===window.I18n.current?'var(--brand,#50d2c2)':'var(--txt,#e0e5e3)')+';font:inherit;font-size:13px;text-align:left;cursor:pointer;white-space:nowrap';
      item.onmouseenter=()=>item.style.background='var(--panel2,#1f2a26)';item.onmouseleave=()=>item.style.background='transparent';
      item.onclick=async()=>{menu.remove();await window.I18n.set(code);};menu.appendChild(item);
    }
    document.body.appendChild(menu);
  });
  document.addEventListener('click',()=>document.getElementById('lang-menu')?.remove());
});
