const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const puppeteer = createRequire(path.resolve(__dirname,'../../resources/app/package.json'))('puppeteer');
const credentialText = fs.readFileSync('C:/Users/cy020/Desktop/后台登录信息-20261011.txt','utf8');
const login = { username:credentialText.match(/^账号：(.*)$/m)[1].trim(), password:credentialText.match(/^密码：(.*)$/m)[1].trim() };
const result = { production:true, runtimeErrors:[], requests:[], unexpectedWrites:[] };
let browser;
(async()=>{
  try {
    browser = await puppeteer.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
    const page = await browser.newPage();
    await page.setViewport({ width:1440,height:1000 });
    await page.evaluateOnNewDocument(()=>{
      window.adminLongTasks=[];
      new PerformanceObserver(list=>{ for(const e of list.getEntries()) adminLongTasks.push({start:e.startTime,duration:e.duration}); }).observe({type:'longtask',buffered:true});
    });
    const started = new Map();
    await page.setRequestInterception(true);
    page.on('pageerror',e=>result.runtimeErrors.push(e.message));
    page.on('request',request=>{
      const uri=new URL(request.url());
      if(uri.pathname==='/cdn-cgi/rum')return request.abort();
      if(!['GET','HEAD','OPTIONS'].includes(request.method())&&!['/api/admin/login','/api/admin/logout'].includes(uri.pathname)) {
        result.unexpectedWrites.push({path:uri.pathname,method:request.method()});return request.abort();
      }
      if(uri.pathname.startsWith('/api/admin/'))started.set(request,performance.now());
      return request.continue();
    });
    page.on('requestfinished',request=>{
      if(started.has(request))result.requests.push({path:new URL(request.url()).pathname,method:request.method(),milliseconds:Math.round(performance.now()-started.get(request))});
    });
    await page.goto('https://axix.cc/admin.html',{waitUntil:'domcontentloaded',timeout:40000});
    await page.type('#admin-username',login.username);await page.type('#admin-password',login.password);
    const loginStart=performance.now();
    await page.click('#admin-login-button');
    await page.waitForFunction(()=>!document.getElementById('admin-app').hidden,{timeout:30000});
    result.appShownMs=Math.round(performance.now()-loginStart);
    await page.waitForFunction(()=>document.getElementById('admin-updated').textContent.startsWith('更新于'),{timeout:60000});
    result.firstDataReadyMs=Math.round(performance.now()-loginStart);
    result.state=await page.evaluate(()=>({usersRows:document.querySelectorAll('#admin-users-body tr').length,depositsRows:document.querySelectorAll('#admin-deposits-body tr').length,allNodes:document.querySelectorAll('*').length,longTasks:adminLongTasks}));
    await page.evaluate(async()=>{ await fetch('/api/admin/logout',{method:'POST'}); });
    result.passed = true;
  } catch(e) { result.error=e.message;process.exitCode=1; }
  finally { if(browser)await browser.close();fs.writeFileSync(path.join(__dirname,'online-baseline.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2)); }
})();
