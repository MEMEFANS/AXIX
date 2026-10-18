const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const publicDir=path.resolve(__dirname,'../../resources/app/public');
const ctx={window:{}};
vm.createContext(ctx);
for(const f of ['i18n-zh-en.js','i18n-extra.js'])vm.runInContext(fs.readFileSync(path.join(publicDir,'js',f),'utf8'),ctx);
const dict=ctx.window.I18nDict, extra=ctx.window.I18nExtra;
module.exports={dict,extra,publicDir};
if(require.main===module){
 const report={counts:{en:Object.keys(dict).length},missing:{},wrongScript:{},numbers:{}};
 const bad={ko:/[\u4e00-\u9fff\u3040-\u30ff\u0400-\u04ff]/,ru:/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/,es:/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff]/,ja:/[\uac00-\ud7af\u0400-\u04ff]/};
 for(const [lang,map]of Object.entries(extra)){
  report.counts[lang]=Object.keys(map).length;
  report.missing[lang]=Object.entries(dict).filter(([k,v])=>!Object.hasOwn(map,k)&&/[\u4e00-\u9fff]/.test(k)).map(([k,v])=>({k,en:v}));
  report.wrongScript[lang]=Object.entries(map).filter(([k,v])=>bad[lang]?.test(v));
  report.numbers[lang]=Object.entries(map).filter(([k,v])=>{const a=k.match(/\d+(?:\.\d+)?%/g),b=v.match(/\d+(?:\.\d+)?%/g);return a&&JSON.stringify(a)!==JSON.stringify(b)});
 }
 fs.writeFileSync(path.join(__dirname,'dictionary-report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({counts:report.counts,missing:Object.fromEntries(Object.entries(report.missing).map(([l,v])=>[l,v.length])),wrongScript:report.wrongScript,numbers:report.numbers},null,2));
}
