import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const publicDir = path.resolve(import.meta.dirname, '../public');
const address = '0x1271000000000000000000000000000000000ddB';
const profile = {authenticated:true,address,balances:{USDT:'125.5',A:'4321.87654321'},deposits:[],withdrawals:[]};
const platform = {account:{availableMargin:'125.5',totalEquity:'557.912654',reservedUsdt:'0',spotValue:'432.412654'},
  symbols:['BTC','ETH'],spot:{A:'4321.87654321'},spotFrozen:{A:'2.25'},marketPrices:{A:0.1},strategy:{},perps:{},orders:[],fills:[]};
const browser = await puppeteer.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try {
  const page = await browser.newPage();
  await page.setViewport({width:390,height:844,isMobile:true});
  const errors=[],scripts=[],held=[];
  let holdPlatform=true;
  page.on('pageerror',error=>errors.push(error.message));
  await page.evaluateOnNewDocument(address=>{
    window.ethereum={request:async({method})=>{
      if(method==='eth_accounts'||method==='eth_requestAccounts')return[address];
      if(method==='eth_chainId')return'0x38';
      if(method==='personal_sign')return'TEST_ONLY_SIGNATURE';
      throw new Error('Unexpected wallet operation: '+method);
    },on:()=>{},removeListener:()=>{}};
  },address);
  await page.setRequestInterception(true);
  page.on('request',request=>{
    const url=new URL(request.url());
    if(url.hostname!=='assets.test')return request.abort();
    const json=data=>request.respond({contentType:'application/json',body:JSON.stringify(data)});
    if(url.pathname.endsWith('.js'))scripts.push(url.pathname);
    if(url.pathname.startsWith('/api/')){
      if(url.pathname==='/api/wallet/login-challenge')return json({message:'TEST_ONLY_LOGIN'});
      if(url.pathname==='/api/wallet/login-sign')return json({ok:true});
      if(request.method()!=='GET')return request.abort();
      if(url.pathname==='/api/wallet/session')return json({authenticated:true,address});
      if(url.pathname==='/api/wallet/profile')return json(profile);
      if(url.pathname==='/api/wallet/config')return json({networks:[],depositEnabled:false,withdrawalEnabled:false});
      if(url.pathname==='/api/platform/profile'){
        if(holdPlatform){held.push(request);return;}
        return json(platform);
      }
      if(url.pathname==='/api/a-token/profile')return json({userId:'TEST',balances:{A:profile.balances.A},miners:[],activations:[],stakes:[]});
      if(url.pathname==='/api/a-token/plans')return json({activation:[],staking:[]});
      if(url.pathname==='/api/market/catalog')return json({markets:[]});
      return json({});
    }
    const file=path.join(publicDir,url.pathname==='/'?'index.html':url.pathname);
    if(!fs.existsSync(file)||!fs.statSync(file).isFile())return request.respond({status:404,body:''});
    const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
    return request.respond({contentType:types[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
  });
  await page.goto('http://assets.test/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.currentWalletProfile?.authenticated,{timeout:8000});
  await page.evaluate(()=>switchTab('account'));
  await page.waitForFunction(()=>!!document.querySelector('#assets-table-body tr b'),{timeout:8000});
  const aixValues=()=>page.evaluate(()=>{
    const row=[...document.querySelectorAll('#assets-table-body tr')].find(r=>r.querySelector('b')?.textContent==='AIX');
    return row?[row.cells[1].querySelector('.assets-total-amount').textContent,row.cells[2].textContent,row.cells[3].textContent]:null;
  });
  const beforePlatform=await aixValues();
  assert(!scripts.some(src=>/trade-chart|lightweight-charts/.test(src)),'Direct assets entry must keep the chart unloaded');
  holdPlatform=false;
  await Promise.all(held.map(request=>request.respond({contentType:'application/json',body:JSON.stringify(platform)})));
  const loadError=await page.evaluate(async()=>{try{await loadPlatformProfile();return null;}catch(error){return error.message;}});
  console.log(JSON.stringify({first_assets_profile_error:loadError,AIX_before_platform_profile:beforePlatform}));
  assert.equal(loadError,null,'Assets profile must load without a chart variable');
  assert.equal(beforePlatform[1],'4,321.87654321','Wallet balance must render while the platform request is pending');
  assert.deepEqual(await aixValues(),['4,324.12654321','4,321.87654321','2.25']);
  const artifactDir=path.resolve(import.meta.dirname,'../../../tools/address-investigation-20261011/assets-quantity-fix');
  fs.mkdirSync(artifactDir,{recursive:true});
  await page.$eval('#assets-table-body',node=>node.scrollIntoView({block:'center'}));
  await page.screenshot({path:path.join(artifactDir,'mobile-balance.png')});
  // A fresh wallet balance takes precedence over a previous platform snapshot.
  await page.evaluate(profile=>ExchangeAssets.renderWallet({...profile,balances:{USDT:'125.5',A:'0'}}),profile);
  assert.deepEqual(await aixValues(),['2.25','0.00','2.25']);
  await page.evaluate(profile=>{
    ExchangeAssets.renderPlatform(null);
    ExchangeAssets.renderWallet({...profile,balances:{USDT:'125.5',A:'0.0000012'}});
  },profile);
  assert.deepEqual(await aixValues(),['0.0000012','0.0000012','0.00'],'Small positive balances cannot look like zero');
  await page.evaluate(()=>ExchangeAssets.renderWallet(null));
  assert.deepEqual(await aixValues(),['0.00','0.00','0.00'],'Logout clears previous holdings');
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('Assets wallet balance browser regression passed: direct entry, no chart, pending profile, fresh zero, small amounts, logout');
}finally{await browser.close();}
