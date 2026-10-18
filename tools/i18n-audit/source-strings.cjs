const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const esbuild=require('../../resources/app/node_modules/esbuild');
const puppeteer=require('../../resources/app/node_modules/puppeteer');
const {publicDir}=require('./dictionaries.cjs');
(async()=>{
 const files=fs.readdirSync(path.join(publicDir,'js')).filter(n=>!/^i18n|^admin-|^operator-admin|^agent\.js/.test(n));
 const strings=[];
 for(const name of files){
  const code=esbuild.transformSync(fs.readFileSync(path.join(publicDir,'js',name),'utf8'),{minifyWhitespace:true,legalComments:'none',charset:'utf8'}).code;
  const matches=code.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g)||[];
  for(const literal of matches){
   if(!/[\u4e00-\u9fff]/.test(literal))continue;
   let text;
   if(literal[0]==='`') text=literal.slice(1,-1).replace(/\$\{[^}]*\}/g,'12');
   else {try{text=vm.runInNewContext(literal);}catch{continue;}}
   if(typeof text==='string')strings.push({file:name,text});
  }
 }
 const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage();await page.goto('http://127.0.0.1:8082');await page.waitForFunction(()=>!!window.I18n);await page.evaluate(()=>I18n.set('en'));
  const issues=await page.evaluate(items=>{
    const result=[];
    for(const item of items){
      const doc=new DOMParser().parseFromString(item.text,'text/html');
      const walker=doc.createTreeWalker(doc.body,NodeFilter.SHOW_TEXT);const texts=[];
      while(walker.nextNode())if(!walker.currentNode.parentElement.closest('script,style,code,pre'))texts.push(walker.currentNode.nodeValue);
      for(const attr of ['placeholder','title','aria-label','alt','data-label'])doc.querySelectorAll('['+attr+']').forEach(el=>texts.push(el.getAttribute(attr)));
      for(const source of texts){
        if(!/[\u4e00-\u9fff]/.test(source)||source.trim().length<2)continue;
        const value=I18n.t(source);
        if(/[\u4e00-\u9fff]/.test(value.replace(/「[^」]*」|«[^»]*»/g,'')))result.push({file:item.file,source:source.trim(),value:value.trim()});
      }
    }
    return result;
  },strings);
  const unique=[...new Map(issues.map(i=>[i.source,i])).values()];
  fs.writeFileSync(path.join(__dirname,'source-report.json'),JSON.stringify(unique,null,2));
  console.log(JSON.stringify(unique,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
