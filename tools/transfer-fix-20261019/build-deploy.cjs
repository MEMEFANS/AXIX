const fs=require('fs');const source=fs.readFileSync('resources/app/public/js/a-token-transfer.js').toString('base64');
const py=`import pathlib,json,base64,hashlib,shutil,time,subprocess,urllib.request,os,re
r=pathlib.Path('/opt/wg-platform')
f='public/js/a-token-transfer.js'
assert hashlib.sha256((r/f).read_bytes()).hexdigest()=='caff37016ea1764129197b8f33c003f009b3ad97c0f3836737b9ea5b698cf5b0','Production transfer changed'
release='transfer-precision-'+time.strftime('%Y%m%d-%H%M%S')
b=r/'backups'/release
b.mkdir(mode=0o700)
files=[f,'public/js/page-loader.js','public/index.html']
old={p:(r/p).read_bytes() for p in files}
for p in files:
 q=b/p;q.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(r/p,q)
new={f:base64.b64decode('${source}')}
s=old[files[1]].decode();s,n=re.subn(r"'a-token-transfer'\\s*:\\s*'[^']*'","'a-token-transfer':'20261019-precision-1'",s);assert n==1
new[files[1]]=s.encode()
s=old[files[2]].decode();s,n=re.subn(r'(/js/page-loader.js\\?v=)[^"\\s]+',r'\\g<1>20261019-transfer-precision-1',s);assert n==1
new[files[2]]=s.encode()
try:
 for p in files:
  q=r/p;tmp=q.with_name(q.name+'.'+release);tmp.write_bytes(new[p]);shutil.copymode(q,tmp);st=q.stat();os.chown(tmp,st.st_uid,st.st_gid)
  if p.endswith('.js'):subprocess.run(['node','--check',str(tmp)],check=True,capture_output=True)
  assert q.read_bytes()==old[p],'Production changed during deployment'
  os.replace(tmp,q)
 for p in files:assert (r/p).read_bytes()==new[p]
 subprocess.run(['systemctl','is-active','--quiet','wg-platform'],check=True)
 with urllib.request.urlopen('http://127.0.0.1:8082/js/a-token-transfer.js?v=20261019-precision-1',timeout=15) as res:assert res.read()==new[f]
 with urllib.request.urlopen('http://127.0.0.1:8082/api/wallet/config',timeout=15) as res:assert res.status==200
 out={'deployed':True,'backup':str(b),'files':{p:hashlib.sha256(new[p]).hexdigest() for p in files},'serviceActive':True,'databaseModified':False}
 (b/'result.json').write_text(json.dumps(out,indent=2));print(json.dumps(out))
except:
 for p in files:shutil.copy2(b/p,r/p)
 raise
`;
// Node needs a .js extension for syntax checks on staged assets.
fs.writeFileSync('tools/transfer-fix-20261019/deploy.py',py.replace("str(tmp)],check=True,capture_output=True)","'--input-type=commonjs'],input=new[p],check=True,capture_output=True)"));
