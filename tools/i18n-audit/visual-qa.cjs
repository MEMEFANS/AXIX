const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const puppeteer=require('../../resources/app/node_modules/puppeteer');
(async()=>{
  const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage();
    await page.setViewport({width:1440,height:1000});
    await page.setRequestInterception(true);
    page.on('request',request=>{
      const url=new URL(request.url());
      if(url.pathname.startsWith('/api/')&&request.method()!=='GET')return request.abort();
      if(url.pathname==='/api/referrals/profile')return request.respond({contentType:'application/json',body:JSON.stringify({code:'TEST',link:'/?ref=TEST'})});
      request.continue();
    });
    await page.goto('http://127.0.0.1:8082',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>!!window.openSocialModal);
    await page.evaluate(()=>{window.currentWalletProfile={authenticated:true};});
    await page.evaluate(()=>openSocialModal('twitter'));
    const social=[];
    for(const lang of ['zh','en','zh-TW','ja','ko','ru','es','zh']){
      await page.evaluate(lang=>I18n.set(lang),lang);
      const result=await page.evaluate(()=>{
        const display=document.getElementById('social-text-code').textContent;
        const link=new URL(document.getElementById('social-go-twitter').href).searchParams.get('text');
        return {display,copy:window._socialText,link};
      });
      assert.equal(result.display,result.copy);assert.equal(result.display,result.link);
      assert(result.display.endsWith('http://127.0.0.1:8082/?ref=TEST #AxiX #AIX'));
      if(['en','ko','ru','es'].includes(lang))assert(!/[\u4e00-\u9fff]/.test(result.display));
      social.push({lang,...result});
    }
    await page.evaluate(()=>{closeLotteryModal();I18n.apply();});
    await page.evaluate(()=>I18n.set('en'));
    const source='确认启动现货网格？\n\n方向：做多\n预计占用：123.45 USDT（从平台可用余额扣除）\n网格：12 格（13 条价格线）\n预计初始挂单：11 单\n每单数量：0.002 币\n当前价：60000.50（WebSocket 实时价）';
    const translated=await page.evaluate(source=>I18n.t(source),source);
    assert(!/[\u4e00-\u9fff]/.test(translated));
    for(const number of ['123.45','12','13','11','0.002','60000.50'])assert(translated.includes(number));
    await page.evaluate(source=>{void confirmDialog(source);},source);
    await page.waitForFunction(()=>document.querySelector('.aim-confirm-dialog')?.textContent.includes('Estimated initial orders: 11'));
    const confirmation=await page.$eval('.aim-confirm-dialog',e=>e.textContent);
    assert(!/[\u4e00-\u9fff]/.test(confirmation));
    await page.click('.aim-confirm-cancel');
    await page.evaluate(()=>alert('本次网格预计需要 123.45 USDT，但平台可用余额只有 12.34 USDT。'));
    await page.waitForFunction(()=>document.querySelector('.aim-confirm-dialog')?.textContent.includes('This grid requires'));
    const alert=await page.$eval('.aim-confirm-dialog',e=>e.textContent);
    assert(alert.includes('123.45 USDT'));assert(alert.includes('12.34 USDT'));assert(!/[\u4e00-\u9fff]/.test(alert));
    await page.click('.aim-confirm-ok');
    const viewports=[];
    for(const width of [1440,390]){
      await page.setViewport({width,height:1000});
      for(const lang of ['zh','zh-TW','en','ja','ko','ru','es']){
        await page.evaluate(l=>I18n.set(l),lang);
        await page.evaluate(()=>switchTab('earn'));
        await new Promise(r=>setTimeout(r,150));
        const layout=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));
        viewports.push({width,lang,...layout});
        if(['en','ru','es'].includes(lang))await page.screenshot({path:path.join(__dirname,`preview-${lang}-${width}.png`),fullPage:false});
      }
    }
    fs.writeFileSync(path.join(__dirname,'visual-report.json'),JSON.stringify({social,source,translated,alert,viewports},null,2));
    console.log(JSON.stringify({social:'PASS: all 7 languages; displayed text, copy text and share URL agree',dynamic:'PASS: actual confirmation and alert dialogs preserve every amount',viewports},null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
