const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../resources/app/public');
const archive=fs.readdirSync(__dirname).filter(file=>/^mobile-wallet-.*\.tar\.gz$/.test(file)).sort()[0];
const before=execFileSync('tar',['-xOf',path.join(__dirname,archive),'public/index.html'],{encoding:'utf8'});
const after=fs.readFileSync(path.join(root,'index.html'),'utf8');
function startup(html){
  const sources=[...html.matchAll(/<script defer src="([^"?]+)(?:\?[^\"]*)?"/g)].map(match=>match[1]);
  sources.push('/vendor/wallet/connector.js');
  const deferred=html.match(/const deferred = \[([\s\S]+?)\];/)?.[1];
  if(deferred)sources.push(...[...deferred.matchAll(/'([^'?]+)(?:\?[^']*)?'/g)].map(match=>match[1]));
  return {scripts:sources.length,sourceBytes:sources.reduce((total,file)=>total+fs.statSync(path.join(root,file)).size,0),sources};
}
const report={before:startup(before),after:startup(after),note:'Uncompressed script source sizes for Chinese startup; not real-phone loading time.'};
fs.writeFileSync(path.join(__dirname,'lazy-loading-measurement.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({before:report.before.scripts,after:report.after.scripts,beforeSourceBytes:report.before.sourceBytes,afterSourceBytes:report.after.sourceBytes}));
