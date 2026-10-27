import pathlib,json,sqlite3,subprocess
r=pathlib.Path('/opt/wg-platform')
out={}
for f in ['public/index.html','public/js/wallet.js','src/a-token-transfer-service.js']:
 s=(r/f).read_text();out[f]=s if 'service' in f else '\n'.join(x for x in s.splitlines() if any(k in x for k in ['wallet.js','a-token-transfer','personal_sign','signWallet','signMessage','TextEncoder','type="module"']))
for f in ['/opt/wg-platform/logs/server.stderr.log','/var/log/nginx/access.log']:
 p=pathlib.Path(f);s=p.read_text(errors='replace')[-3000000:];out[f]='\n'.join(x for x in s.splitlines() if 'transfer' in x.lower() or '72bf4d' in x.lower())[-14000:]
print(json.dumps(out,ensure_ascii=False))
