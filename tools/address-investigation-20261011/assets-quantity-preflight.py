import pathlib,json,hashlib,base64,gzip,datetime
root=pathlib.Path('/opt/wg-platform')
out={'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':{},'protected':{}}
for name in ['public/js/assets.js','public/js/trade-account.js','public/js/page-loader.js','public/index.html']:
    data=(root/name).read_bytes();out['files'][name]={'sha256':hashlib.sha256(data).hexdigest(),'gzip_base64':base64.b64encode(gzip.compress(data)).decode()}
for name in ['src/server.js','src/platform-service.js','src/wallet-service.js','src/a-token-team-service.js','src/a-token-income.js','src/a-token-admin-income.js','.env']:
    out['protected'][name]=hashlib.sha256((root/name).read_bytes()).hexdigest()
print(json.dumps(out,ensure_ascii=False))
