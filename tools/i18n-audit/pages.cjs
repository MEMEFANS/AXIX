const fs=require('node:fs');
const path=require('node:path');
const puppeteer=require('../../resources/app/node_modules/puppeteer');
const {dict,extra}=require('./dictionaries.cjs');
(async()=>{
 const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
 const page=await browser.newPage();await page.setViewport({width:1440,height:1000});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8082',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>!!window.I18n&&!!window.earnSwitch);
 await page.evaluate(()=>I18n.set('zh'));
 const tabs=['earn','points','whitepaper','ai-managed','a-token-trade','overview','leaderboard','referrals','account','support','community'];
 const report={errors,pages:{},sources:[],residual:{},fallback:{}};
 const inspect=()=>{
   const p=document.body;if(!p)return[];
   const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT),rows=[];
   while(walker.nextNode()){
     const n=walker.currentNode,el=n.parentElement,t=n.nodeValue.trim();
     if(t&&!el.closest('script,style,noscript,code,pre,[data-no-translate]'))rows.push(t);
   }
   p.querySelectorAll('[placeholder],[title],[aria-label],[alt],[data-label]').forEach(el=>{
     if(el.closest('[data-no-translate]'))return;
     for(const a of ['placeholder','title','aria-label','alt','data-label'])if(el.hasAttribute(a))rows.push(el.getAttribute(a));
   });
   return [...new Set(rows)];
 };
 for(const tab of tabs){
   await page.evaluate(t=>switchTab(t),tab);
   await new Promise(r=>setTimeout(r,300));
   await page.evaluate(()=>I18n.set('zh'));
   report.pages[tab]=await page.evaluate(inspect);
 }
 for(const scope of ['spot','perp','stock']){
   await page.evaluate(s=>s==='stock'?openStockPage():openTradePage(s),scope);
   await new Promise(r=>setTimeout(r,400));
   await page.evaluate(()=>I18n.set('zh'));
   report.pages[scope]=await page.evaluate(inspect);
 }
 // Expand read-only secondary views using isolated test data. All writes are blocked.
 await page.setRequestInterception(true);
 page.on('request',req=>{
   const url=new URL(req.url());
   if(url.pathname.startsWith('/api/')&&req.method()!=='GET')return req.abort();
   if(url.pathname.endsWith('/team/profile'))return req.respond({contentType:'application/json',body:JSON.stringify({level:10,levelLabel:'A10',directCount:1,teamCount:2,byKind:{direct_count:1,a10_pool_share:1},directs:[{wallet:'0x0000000000000000000000000000000000000001',shortAddress:'Test wallet',level:0,personalA:0,minerCount:1}],TEAM_LEVELS:[]})});
   if(url.pathname==='/api/referrals/profile')return req.respond({contentType:'application/json',body:JSON.stringify({code:'TEST',link:'/?ref=TEST'})});
   if(url.pathname==='/api/a-token/profile')return req.respond({contentType:'application/json',body:JSON.stringify({userId:'TEST',balances:{A:5000},activations:[],miners:[{plan:'mini120',status:'active',expiresAt:Date.now()+86400000,total:100,dailyTarget:3.33,totalEarned:10,remaining:90}],stakes:[{id:'TEST',planId:'current',label:'活期',flexible:true,status:'active',principal:100,outstandingPrincipal:100,interestEarned:1,dailyRateBps:30}]})});
   req.continue();
 });
 await page.evaluate(()=>{window.currentWalletProfile={authenticated:true};window.currentWalletConnection={address:'0x0000000000000000000000000000000000000001'};});
 await page.evaluate(()=>switchTab('earn'));
 for(const sub of ['activation','miner','staking','team']){
   await page.evaluate(s=>earnSwitch(s),sub);
   await new Promise(r=>setTimeout(r,400));await page.evaluate(()=>I18n.set('zh'));
   report.pages['earn-'+sub]=await page.evaluate(inspect);
 }
 await page.evaluate(()=>earnStake('current'));
 await new Promise(r=>setTimeout(r,100));await page.evaluate(()=>I18n.set('zh'));
 report.pages['stake-modal']=await page.evaluate(inspect);
 await page.evaluate(()=>document.getElementById('earn-stake-modal')?.remove());
 await page.evaluate(()=>openEarnPointsModal());await page.evaluate(()=>I18n.set('zh'));
 report.pages['points-tasks']=await page.evaluate(inspect);
 await page.evaluate(()=>closeLotteryModal());
 await page.evaluate(()=>fillAddress('TEST'));await page.evaluate(()=>I18n.set('zh'));
 report.pages['delivery-modal']=await page.evaluate(inspect);
 await page.evaluate(()=>closeLotteryModal());
 report.sources=[...new Set(Object.values(report.pages).flat())].filter(t=>/[\u4e00-\u9fff]/.test(t));
 const keys=Object.keys(dict).filter(k=>k.trim().length>1||k!==k.trim()).sort((a,b)=>b.length-a.length);
 const re=new RegExp(keys.map(k=>k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g');
 for(const lang of ['en','zh-TW','ja','ko','ru','es']){
  const map={...dict,...extra[lang]};
  await page.evaluate(l=>I18n.set(l),lang);
  const translated=await page.evaluate(sources=>sources.map(source=>({source,value:I18n.t(source)})),report.sources);
  report.residual[lang]=translated.filter(({source,value})=>{
    if(lang==='en'||lang==='ko'||lang==='ru'||lang==='es')return /[\u4e00-\u9fff]/.test(value.replace(/「[^」]*」|«[^»]*»/g,''));
    return value===source&&lang==='ja'&&!Object.hasOwn(extra[lang],source);
  });
  report.fallback[lang]=lang==='en'?[]:report.sources.filter(k=>Object.hasOwn(dict,k)&&!Object.hasOwn(extra[lang]||{},k));
 }
 fs.writeFileSync(path.join(__dirname,'page-report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({pages:Object.fromEntries(Object.entries(report.pages).map(([k,v])=>[k,v.length])),sources:report.sources.length,residual:Object.fromEntries(Object.entries(report.residual).map(([k,v])=>[k,v.length])),fallback:report.fallback,errors},null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
