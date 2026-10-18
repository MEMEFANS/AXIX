const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const puppeteer=require('../../resources/app/node_modules/puppeteer');
(async()=>{
  const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage();
    let authenticated=false;
    await page.setViewport({width:390,height:1200,isMobile:true,hasTouch:true});
    await page.setRequestInterception(true);
    page.on('request',request=>{
      const url=new URL(request.url());
      if(url.hostname!=='127.0.0.1')return request.abort();
      if(url.pathname.startsWith('/api/')&&request.method()!=='GET')return request.abort();
      const json=value=>request.respond({contentType:'application/json',body:JSON.stringify(value)});
      if(url.pathname==='/vendor/wallet/connector.js')return request.respond({contentType:'text/javascript',body:`
        const provider={request:async()=>{throw Object.assign(new Error('User rejected'),{code:4001})}};
        const connection={address:'0x1271000000000000000000000000000000000ddB',provider,label:'Test Wallet'};
        window.WGWalletConnector={initialize:async()=>{},onChange:()=>{},restore:async()=>connection,switchChain:async()=>56,getConnection:()=>connection};
        window.dispatchEvent(new Event('wg-wallet-connector-ready'));
      `});
      if(url.pathname==='/api/wallet/profile')return json(authenticated
        ? {authenticated:true,address:'0x1271000000000000000000000000000000000ddB',balances:{USDT:'0'},deposits:[],withdrawals:[]}
        : {authenticated:false});
      if(url.pathname==='/api/a-token/profile')return json({userId:'TEST',balances:{A:'0'},miners:[],activations:[],stakes:[]});
      if(url.pathname==='/api/a-token/team/profile')return json({directs:[],TEAM_LEVELS:[]});
      if(url.pathname==='/api/referrals/profile')return json({code:'TEST',link:'/?ref=TEST'});
      if(url.pathname==='/api/platform/profile')return json({account:{},strategy:{},spot:{},perps:{},orders:[],fills:[]});
      request.continue();
    });
    await page.goto('http://127.0.0.1:8082/',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.currentWalletConnection?.address&&!connectorRestoring);
    await page.evaluate(()=>I18n.set('zh'));
    await page.waitForFunction(()=>document.querySelector('.btn-activate')?.textContent.includes('钱包已连接'));
    assert(!await page.evaluate(()=>!!window.currentWalletProfile?.authenticated));
    await page.screenshot({path:path.join(__dirname,'钱包已连接待验证-移动端.png')});
    const layouts=[];
    for(const lang of ['zh','zh-TW','en','ja','ko','ru','es']){
      await page.evaluate(lang=>I18n.set(lang),lang);
      layouts.push(await page.evaluate(lang=>({lang,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,button:document.querySelector('.btn-activate').textContent}),lang));
    }
    authenticated=true;
    await page.evaluate(()=>{
      I18n.set('zh');
      renderWalletProfile({authenticated:true,address:'0x1271000000000000000000000000000000000ddB',balances:{USDT:'0'},deposits:[],withdrawals:[]});
    });
    await page.waitForFunction(()=>document.querySelector('.btn-activate')?.textContent.includes('立即激活'));
    // Wait for translation observers and the browser to paint the new state before capturing it.
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert(await page.evaluate(()=>!!window.currentWalletProfile?.authenticated));
    assert.match(await page.$eval('.btn-activate',button=>button.textContent),/立即激活/);
    await page.screenshot({path:path.join(__dirname,'身份验证完成-移动端.png')});
    fs.writeFileSync(path.join(__dirname,'layout-report.json'),JSON.stringify(layouts,null,2));
    console.log(JSON.stringify({mode:'isolated simulated wallet; all POST requests blocked',layouts},null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
