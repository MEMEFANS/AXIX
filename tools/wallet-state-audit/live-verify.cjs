const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'deploy-manifest.json'),'utf8').replace(/^\uFEFF/,''));
(async()=>{
  const results=[];
  const stamp=Date.now();
  for(const [file,hash] of Object.entries(manifest)){
    const url='https://axix.cc/'+file.slice('public/'.length)+'?mobile-release='+stamp;
    const response=await fetch(url,{signal:AbortSignal.timeout(20000),headers:{'Cache-Control':'no-cache'}});
    const body=Buffer.from(await response.arrayBuffer());
    const actual=crypto.createHash('sha256').update(body).digest('hex');
    const match=response.ok&&actual===hash;
    results.push({file,status:response.status,bytes:body.length,match,encoding:response.headers.get('content-encoding'),cache:response.headers.get('cf-cache-status')});
    console.log(`${match?'PASS':'FAIL'} ${response.status} ${file}`);
  }
  const response=await fetch('https://axix.cc/?mobile-release='+stamp,{signal:AbortSignal.timeout(20000)});
  const html=await response.text();
  const versions={wallet:html.includes('/js/wallet.js?v=66'),connector:html.includes('/vendor/wallet/connector.js?v=16'),core:html.includes('/js/core.js?v=83'),pageLoader:html.includes('/js/page-loader.js?v=1'),noEagerTrade:!html.includes("'/js/trade-chart.js?v=24'")};
  fs.writeFileSync(path.join(__dirname,'live-verification.json'),JSON.stringify({checkedAt:new Date().toISOString(),results,homeStatus:response.status,versions},null,2));
  if(!results.every(result=>result.match)||!response.ok||!Object.values(versions).every(Boolean))throw new Error('Live content verification failed');
  console.log('PASS: public HTTPS homepage and all deployed assets match the local release.');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
