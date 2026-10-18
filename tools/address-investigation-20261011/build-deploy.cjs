const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const root=__dirname,app=path.resolve(root,'../../resources/app');
const baseline=JSON.parse(fs.readFileSync(path.join(root,'production-sources.json'),'utf8'));
const files={};
for(const [file,original] of Object.entries(baseline)){
  const captured=fs.readFileSync(path.join(root,'before-download',file));
  if(crypto.createHash('sha256').update(captured).digest('hex')!==original.sha256)throw new Error('Invalid captured baseline: '+file);
  const body=fs.readFileSync(path.join(app,file));
  files[file]={before:original.sha256,after:crypto.createHash('sha256').update(body).digest('hex'),body:body.toString('base64')};
}
fs.writeFileSync(path.join(root,'deploy-manifest.json'),JSON.stringify(Object.fromEntries(Object.entries(files).map(([k,v])=>[k,{before:v.before,after:v.after}])),null,2));
const payload=zlib.gzipSync(Buffer.from(JSON.stringify(files))).toString('base64');
const template=fs.readFileSync(path.join(root,'deploy-template.py'),'utf8');
fs.writeFileSync(path.join(root,'deploy-generated.py'),template.replace('__PAYLOAD__',payload));
console.log('Packaged '+Object.keys(files).length+' files; gzip payload '+payload.length+' bytes');
