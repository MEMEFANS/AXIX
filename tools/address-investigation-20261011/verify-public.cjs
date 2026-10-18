const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=__dirname,manifest=JSON.parse(fs.readFileSync(path.join(root,'deploy-manifest.json'),'utf8'));
(async()=>{
  const result={checkedAt:new Date().toISOString(),checks:[]};
  for(const [uri,file] of [['/admin.html','public/admin.html'],['/js/admin-lottery.js?v=4-security-20261011','public/js/admin-lottery.js'],['/js/admin-community.js?v=7-security-20261011','public/js/admin-community.js']]){
    const response=await fetch('https://axix.cc'+uri,{signal:AbortSignal.timeout(15000),headers:{'Cache-Control':'no-cache'}});
    const body=Buffer.from(await response.arrayBuffer());const hash=crypto.createHash('sha256').update(body).digest('hex');
    result.checks.push({uri,status:response.status,sha256:hash,expected:manifest[file].after,matches:response.ok&&hash===manifest[file].after,cacheStatus:response.headers.get('cf-cache-status')});
  }
  fs.writeFileSync(path.join(root,'public-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  if(result.checks.some(x=>!x.matches))process.exitCode=1;
})().catch(error=>{console.error(error.message);process.exitCode=1;});
