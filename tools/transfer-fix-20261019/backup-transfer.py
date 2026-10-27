import pathlib,json,tarfile,hashlib
r=pathlib.Path('/opt/wg-platform/backups')
out={}
for f in ['public/js/a-token-transfer.js','public/js/page-loader.js']:
 for name in ['sync-20261017-133747','sync-20261017-034523','sync-20261017-132344','sync-20261018-000141']:
  p=r/name/'previous.tar.gz'
  if p.exists():
   try:
    with tarfile.open(p) as t:
     matches=[n for n in t.getnames() if n.endswith(f)]
     if matches:
      b=t.extractfile(matches[0]).read();out.setdefault(f,[]).append({'backup':name,'source':b.decode(errors='replace'),'hash':hashlib.sha256(b).hexdigest()})
   except Exception as e: pass
for name in ['sync-20261017-133747','sync-20261017-034523']:
 p=r/name/'public/js/a-token-transfer.js'
 if p.exists():out.setdefault('direct',[]).append({'backup':name,'source':p.read_text()})
print(json.dumps(out,ensure_ascii=False))
