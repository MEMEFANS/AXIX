const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const root=__dirname,app=path.resolve(root,'../../resources/app');
const data=JSON.parse(fs.readFileSync(path.join(root,'production-sources.json'),'utf8'));
const baseline={};let changed=false;
for(const [file,record] of Object.entries(data)){
  const body=zlib.gunzipSync(Buffer.from(record.body,'base64'));
  const destination=path.join(root,'before-download',file);
  fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,body);
  const local=fs.readFileSync(path.join(app,file),'utf8').replace(/\r/g,'');
  baseline[file]={sha256:record.sha256,normalizedMatch:local===body.toString('utf8').replace(/\r/g,'')};
  if(!baseline[file].normalizedMatch)changed=true;
}
fs.writeFileSync(path.join(root,'production-baseline.json'),JSON.stringify(baseline,null,2));
console.log(JSON.stringify(baseline,null,2));if(changed)process.exitCode=2;
