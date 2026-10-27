import pathlib,tarfile,json,hashlib
r=pathlib.Path('/opt/wg-platform/backups');out={}
for p in r.iterdir():
 if p.name.startswith(('sync-202610','aix-','code-','security-')):
  q=p/'previous.tar.gz'
  if q.exists():
   try:
    with tarfile.open(q) as t:
     for n in t.getnames():
      if n.endswith('a-token-transfer.js') or n.endswith('a-token-transfer-service.js'):
       b=t.extractfile(n).read();out.setdefault(n,[]).append({'backup':p.name,'source':b.decode(errors='replace'),'hash':hashlib.sha256(b).hexdigest()})
  except:pass
print(json.dumps(out,ensure_ascii=False))
