import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
const publicDir=path.resolve(import.meta.dirname,'../public');
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
 const page=await browser.newPage();
 page.on('console',message=>{if(message.type()==='error')console.error(message.text());});
 page.on('pageerror',error=>console.error(error.message));
 const loads=[];
 await page.setRequestInterception(true);
 page.on('request',request=>{
   const url=new URL(request.url());
   if(url.hostname!=='i18n.test')return request.abort();
   if(url.pathname==='/')return request.respond({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><title>积分抽奖</title><body>
     <button id="lang-toggle" title="切换语言">🌐</button>
     <button data-nav-zh="积分抽奖">积分抽奖</button>
     <span id="duplicate">关闭</span><span id="close-trade">平仓</span>
     <div id="source">有效期</div><div id="trade-tif-field"><span>有效期</span></div>
     <p id="dynamic">100 AIX 总产出</p><p id="count">1 条记录</p>
     <input placeholder="收件人姓名"><img alt="比特币"><div data-label="收益">1,234.56 AIX</div>
     <p data-no-translate>AxiX 你好</p><code>const 中文 = 1;</code><style>/* 中文样式 */</style>
     <script id="payload">window.marker='中文代码';</script><script src="/js/i18n.js"></script>
   </body>`});
   if(!url.pathname.startsWith('/js/'))return request.respond({status:204,body:''});
   const name=path.basename(url.pathname);loads.push(name);
   request.respond({contentType:'text/javascript; charset=utf-8',body:fs.readFileSync(path.join(publicDir,'js',name),'utf8')});
 });
 await page.goto('http://i18n.test/');await page.waitForFunction(()=>!!window.I18n);
 const original=await page.evaluate(()=>({texts:Array.from(document.querySelectorAll('body *')).filter(e=>e.children.length===0).map(e=>e.textContent),title:document.title,placeholder:document.querySelector('input').placeholder,script:document.getElementById('payload').textContent}));
 assert(!loads.includes('i18n-zh-en.js'),'Chinese startup must not load dictionaries');
 for(const lang of ['en','zh-TW','ja','ko','ru','es','en','ja','zh']){
   assert(await page.evaluate(l=>I18n.set(l),lang),'Language switch failed: '+lang);
   assert.equal(await page.evaluate(()=>I18n.current),lang);
   assert.equal(await page.evaluate(()=>document.getElementById('payload').textContent),original.script);
   assert.equal(await page.evaluate(()=>document.querySelector('code').textContent),'const 中文 = 1;');
   assert.equal(await page.evaluate(()=>document.querySelector('[data-no-translate]').textContent),'AxiX 你好');
 }
 const restored=await page.evaluate(()=>({texts:Array.from(document.querySelectorAll('body *')).filter(e=>e.children.length===0).map(e=>e.textContent),title:document.title,placeholder:document.querySelector('input').placeholder,script:document.getElementById('payload').textContent}));
 // Dynamic dictionary script tags live in head, not in user-facing body content.
 assert.deepEqual(restored,original,'Switching back must restore identical Chinese sources');
 await page.evaluate(()=>I18n.set('en'));
 assert.equal(await page.$eval('#duplicate',e=>e.textContent),'Close');
 assert.equal(await page.$eval('#source',e=>e.textContent),'Validity');
 assert.equal(await page.$eval('#trade-tif-field span',e=>e.textContent),'Time in Force');
 assert.equal(await page.$eval('#dynamic',e=>e.textContent),'Total output: 100 AIX');
 assert.equal(await page.$eval('#count',e=>e.textContent),'Records: 1');
 await page.evaluate(()=>{document.getElementById('dynamic').textContent='1,500.25 AIX 总产出';const p=document.createElement('p');p.id='late';p.textContent='暂无资金费数据';document.body.appendChild(p);document.querySelector('input').placeholder='联系电话';});
 await page.waitForFunction(()=>document.getElementById('dynamic').textContent==='Total output: 1,500.25 AIX');
 assert.equal(await page.$eval('#late',e=>e.textContent),'No funding data yet');
 assert.equal(await page.$eval('input',e=>e.placeholder),'Contact phone number');
 await page.evaluate(()=>I18n.set('zh'));
 assert.equal(await page.$eval('#dynamic',e=>e.textContent),'1,500.25 AIX 总产出');
 assert.equal(await page.$eval('input',e=>e.placeholder),'联系电话');
 await page.evaluate(()=>Promise.all([I18n.set('ja'),I18n.set('ko'),I18n.set('es')]));
 assert.equal(await page.evaluate(()=>I18n.current),'es','Latest switch must win');
 assert.equal(loads.filter(n=>n==='i18n-extra.js').length,1);
 assert.equal(loads.filter(n=>n==='i18n-zh-en.js').length,1);
 console.log('PASS: first switch loading, all 7 languages, source restoration, dynamic text/attributes, amount preservation, excluded code, contextual terminology and switch races');
}finally{await browser.close();}
