import pathlib,tarfile,json,hashlib
r=pathlib.Path('/opt/wg-platform')
out={}
for f in ['src/a-token-api.js','src/a-token-transfer-service.js','public/js/a-token-transfer.js','public/js/page-loader.js','public/js/wallet.js']:
 p=r/f;cur=p.read_bytes();out[f]={'current':hashlib.sha256(cur).hexdigest(),'mtime':p.stat().st_mtime,'versions':[]}
for p in sorted((r/'backups').iterdir(),key=lambda p:p.stat().st_mtime,reverse=True):
 found=[]
 q=p/'previous.tar.gz'
 if q.exists():
  try:
   with tarfile.open(q) as t:names=t.getnames()
  except: names=[]
  found=names
 for f in out:
  if f in found or f.lstrip('/') in found:
   out[f]['versions'].append({'backup':str(p),'archive':str(q)})
for p in sorted((r/'backups').iterdir(),key=lambda p:p.stat().st_mtime,reverse=True):
 for f in out:
  q=p/f
  if q.exists():
   data=q.read_bytes();out[f]['versions'].append({'backup':str(q),'sha':hashlib.sha256(data).hexdigest(),'source':data.decode(errors='replace')})
print(json.dumps(out,ensure_ascii=False))
