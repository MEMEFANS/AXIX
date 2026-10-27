import pathlib,tarfile,json,hashlib
r=pathlib.Path('/opt/wg-platform/backups');out={}
for name in ['sync-20261017-133747','sync-20261017-034523','sync-20261018-000141']:
 p=r/name/'previous.tar.gz'
 if p.exists():
  with tarfile.open(p) as t:
   for n in t.getnames():
    if n.endswith('a-token-transfer.js') or n.endswith('a-token-transfer-service.js'):
     b=t.extractfile(n).read();out.setdefault(n,[]).append({'backup':name,'source':b.decode(errors='replace'),'hash':hashlib.sha256(b).hexdigest()})
print(json.dumps(out,ensure_ascii=False))
