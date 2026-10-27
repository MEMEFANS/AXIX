import pathlib,tarfile,json
r=pathlib.Path('/opt/wg-platform/backups'); out={}
for name in ['sync-20261017-133747','sync-20261017-034523']:
 p=r/name/'previous.tar.gz'; print(str(p),p.exists())
 if p.exists():
  with tarfile.open(p) as t:
   ns=t.getnames(); print(ns)
   for n in ns:
    if 'a-token-transfer' in n: out[n+'-'+name]=t.extractfile(n).read().decode(errors='replace')
print(json.dumps(out,ensure_ascii=False))
