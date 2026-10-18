const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const appRoot = path.resolve(__dirname, '../../resources/app');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname,'deploy-manifest.json'),'utf8').replace(/^\uFEFF/,''));
const stamp = Date.now();
async function checkFile([file,wanted]) {
  const response = await fetch('https://axix.cc/'+(file==='public/index.html'?'':file.slice(7))+'?auth-release='+stamp, {signal:AbortSignal.timeout(25000),headers:{'Cache-Control':'no-cache'}});
  const body=Buffer.from(await response.arrayBuffer());
  const actual=crypto.createHash('sha256').update(body).digest('hex');
  const match=response.ok&&actual===wanted;
  return {file,status:response.status,bytes:body.length,match};
}
(async()=>{
  const assets=await Promise.all(Object.entries(manifest).filter(([file])=>file.startsWith('public/')).map(checkFile));
  const start=Date.now();
  const response=await fetch('https://axix.cc/api/wallet/session?auth-release='+stamp,{signal:AbortSignal.timeout(15000),headers:{'Cache-Control':'no-cache'}});
  const session=await response.json();
  const sessionCheck={status:response.status,milliseconds:Date.now()-start,unauthenticated:session.authenticated===false,noStore:response.headers.get('cache-control')?.includes('no-store')};
  const body=JSON.stringify({address:'0x00000000000000000000000000000000000000F1',requestId:crypto.randomUUID()});
  const challenges=[];
  for(let attempt=0;attempt<2;++attempt){
    const r=await fetch('https://axix.cc/api/wallet/login-challenge',{method:'POST',headers:{'Content-Type':'application/json','Origin':'https://axix.cc'},body,signal:AbortSignal.timeout(15000)});
    const value=await r.json();
    challenges.push({status:r.status,message:value.message});
  }
  const challengeCheck={statuses:challenges.map(r=>r.status),retryStable:challenges[0].message===challenges[1].message&&/^You are sign in AxiX \d{6}$/.test(challenges[0].message||'')};
  const verified=assets.every(r=>r.match)&&response.ok&&sessionCheck.unauthenticated&&sessionCheck.noStore&&challengeCheck.statuses.every(s=>s===200)&&challengeCheck.retryStable;
  fs.writeFileSync(path.join(__dirname,'live-verification.json'),JSON.stringify({checkedAt:new Date().toISOString(),verified,assets,sessionCheck,challengeCheck},null,2));
  assets.forEach(row=>console.log(`${row.match?'PASS':'FAIL'} HTTP ${row.status} ${row.file}`));
  console.log('SESSION:',JSON.stringify(sessionCheck));
  console.log('CHALLENGE:',JSON.stringify(challengeCheck));
  if(!verified)throw new Error('Public deployment verification failed');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
