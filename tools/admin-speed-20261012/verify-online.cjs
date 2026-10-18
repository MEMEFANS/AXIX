const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {createRequire}=require('node:module');
const puppeteer=createRequire(path.resolve(__dirname,'../../resources/app/package.json'))('puppeteer');
const origin='https://axix.cc';
const credentialText=fs.readFileSync('C:/Users/cy020/Desktop/后台登录信息-20261011.txt','utf8');
const login={username:credentialText.match(/^账号：(.*)$/m)[1].trim(),password:credentialText.match(/^密码：(.*)$/m)[1].trim()};
const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'release-manifest.json'),'utf8'));
const result={production:true,scenarios:[],runtimeErrors:[],unexpectedWrites:[],requests:[],static:[]};
const mark=message=>{result.scenarios.push(message);console.log('PASS: '+message);};
let browser,page,loggedIn=false;
(async()=>{
 try {
  for(const [uri,name] of Object.entries({'/admin.html':'public/admin.html','/js/operator-admin.js?v=20261012-admin-speed-1':'public/js/operator-admin.js','/js/admin-lottery.js?v=20261012-admin-speed-1':'public/js/admin-lottery.js','/js/admin-agents.js?v=20261012-admin-speed-1':'public/js/admin-agents.js'})){
   const response=await fetch(origin+uri,{signal:AbortSignal.timeout(20000)});
   if(response.status!==200)throw Error('Public response '+response.status+': '+uri);
   const hash=crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
   if(hash!==manifest[name].after)throw Error('Public cache contains another version: '+uri);
   result.static.push({uri,status:response.status,sha256:hash});
  }
  mark('public domain serves the deployed HTML and all three versioned admin scripts');
  browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  page=await browser.newPage();await page.setViewport({width:1440,height:1000});
  await page.evaluateOnNewDocument(()=>{
   window.adminLongTasks=[];
   new PerformanceObserver(list=>{for(const entry of list.getEntries())adminLongTasks.push(Math.round(entry.duration));}).observe({type:'longtask',buffered:true});
  });
  page.on('pageerror',error=>result.runtimeErrors.push(error.message));
  const started=new Map();const paths=[];
  await page.setRequestInterception(true);
  page.on('request',request=>{
   const url=new URL(request.url());
   if(url.pathname==='/cdn-cgi/rum')return request.abort();
   if(!['GET','HEAD','OPTIONS'].includes(request.method())&&!['/api/admin/login','/api/admin/logout'].includes(url.pathname)){
    result.unexpectedWrites.push({path:url.pathname,method:request.method()});return request.abort();
   }
   if(url.pathname.startsWith('/api/admin/')){started.set(request,performance.now());paths.push(url.pathname+url.search);}
   return request.continue();
  });
  page.on('requestfinished',request=>{
   if(started.has(request))result.requests.push({path:new URL(request.url()).pathname,method:request.method(),milliseconds:Math.round(performance.now()-started.get(request))});
  });
  const response=await page.goto(origin+'/admin.html',{waitUntil:'domcontentloaded',timeout:40000});
  const headers=response.headers();if(headers['cache-control']!=='no-store'||headers['content-security-policy'].match(/script-src[^;]*unsafe-inline/))throw Error('Admin CSP/cache security changed');
  await page.waitForFunction(()=>document.activeElement?.id==='admin-username');
  await page.type('#admin-username',login.username);await page.type('#admin-password',login.password);
  const start=performance.now();await page.click('#admin-login-button');
  await page.waitForFunction(()=>!document.getElementById('admin-app').hidden,{timeout:30000});loggedIn=true;
  result.appShownMs=Math.round(performance.now()-start);
  await page.waitForFunction(()=>document.getElementById('admin-updated').textContent.startsWith('更新于'),{timeout:30000});
  result.firstDataReadyMs=Math.round(performance.now()-start);
  result.state=await page.evaluate(()=>({usersRows:document.querySelectorAll('#admin-users-body tr').length,depositsRows:document.querySelectorAll('#admin-deposits-body tr').length,allNodes:document.querySelectorAll('*').length,longTasks:adminLongTasks}));
  if(result.state.usersRows||result.state.depositsRows||!paths.includes('/api/admin/dashboard?view=overview'))throw Error('Overview eagerly loads user/deposit tables');
  mark('online login and overview complete without hidden bulk tables');
  await page.click('[data-admin-page="users"]');
  await page.waitForFunction(()=>document.querySelectorAll('[data-detail-btn]').length===50&&!document.getElementById('admin-user-count').textContent.includes('正在'));
  const first=await page.$$eval('[data-detail-btn]',nodes=>nodes.map(node=>node.dataset.detailBtn));
  await page.click('#admin-users-next');await page.waitForFunction(()=>document.getElementById('admin-users-page-status').textContent.startsWith('第 51'));
  const next=await page.$$eval('[data-detail-btn]',nodes=>nodes.map(node=>node.dataset.detailBtn));
  if(new Set([...first,...next]).size!==100)throw Error('User pagination overlaps');
  await page.$eval('#admin-user-search',(node,value)=>{node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));},first[0]);
  await page.waitForFunction(()=>document.querySelectorAll('[data-detail-btn]').length===1&&!document.getElementById('admin-user-count').textContent.includes('正在'));
  if(await page.$eval('[data-detail-btn]',node=>node.dataset.detailBtn)!==first[0])throw Error('Search missed user on another page');
  mark('online users endpoint displays 50 per page and search reaches the complete user set');
  const lotteryStart=paths.length;
  await page.click('[data-admin-page="lottery"]');await page.waitForSelector('[data-prob]');
  if(JSON.stringify(paths.slice(lotteryStart).filter(uri=>uri.startsWith('/api/admin/lottery/')))!==JSON.stringify(['/api/admin/lottery/prizes']))throw Error('Lottery preloads other subtabs');
  await page.click('[data-al-tab="social"]');await page.waitForSelector('#al-social-status');
  await page.click('[data-al-tab="physical"]');await page.waitForSelector('#al-physical-status');
  mark('lottery prize/social/physical tabs load only when selected');
  await page.click('[data-admin-page="a-miner"]');await page.waitForSelector('#am-open-funds');
  if(await page.$('#am-grant'))throw Error('Operator miner funding controls returned');
  const denied=await page.evaluate(async()=>{
   const paths=['/api/admin/test-credits','/api/admin/withdrawals','/api/admin/a-token/grant','/api/admin/a-token/debit','/api/admin/a-token/grant-miner'];
   const results=[];for(const uri of paths){const res=await fetch(uri);results.push({status:res.status,code:(await res.json()).code});}return results;
  });
  if(denied.some(item=>item.status!==403||item.code!=='FUNDS_ADMIN_REQUIRED'))throw Error('Public operator funds isolation failed');
  mark('public operator funding routes remain denied after deployment');
  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await page.waitForFunction(()=>!document.getElementById('admin-app').hidden&&document.getElementById('admin-updated').textContent.startsWith('更新于'));
  await page.click('#admin-menu-toggle');
  await page.waitForFunction(()=>document.body.classList.contains('admin-nav-open')&&document.getElementById('admin-sidebar').getBoundingClientRect().left>=-1);
  await page.click('[data-admin-page="users"]');
  await page.waitForFunction(()=>document.querySelector('[data-admin-panel="users"]').classList.contains('active')&&document.querySelectorAll('[data-detail-btn]').length===50&&!document.getElementById('admin-user-count').textContent.includes('正在'));
  await page.waitForFunction(()=>!document.body.classList.contains('admin-nav-open')&&document.getElementById('admin-sidebar').getBoundingClientRect().right<=1);
  const pager=await page.$eval('#admin-users-next',node=>{const box=node.getBoundingClientRect();return {left:box.left,right:box.right,width:innerWidth};});
  if(pager.left<0||pager.right>pager.width)throw Error('Mobile pager outside viewport');
  mark('public mobile navigation and user pagination display correctly');
  if(result.runtimeErrors.length||result.unexpectedWrites.length)throw Error('Browser error or unexpected write');
  result.passed=true;
 }catch(error){result.error=error.stack;console.error(error.message);process.exitCode=1;}
 finally{
  if(loggedIn&&page)await page.evaluate(async()=>{await fetch('/api/admin/logout',{method:'POST'});}).catch(()=>{});
  if(browser)await browser.close();
  result.checkedAtUtc=new Date().toISOString();
  fs.writeFileSync(path.join(__dirname,'online-verification.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({passed:result.passed,appShownMs:result.appShownMs,firstDataReadyMs:result.firstDataReadyMs,state:result.state,runtimeErrors:result.runtimeErrors},null,2));
 }
})();
