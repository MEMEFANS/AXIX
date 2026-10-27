import pathlib,json,subprocess
r=pathlib.Path('/opt/wg-platform')
out={}
out['backups']=subprocess.run(['find','/opt/wg-platform/backups','/root','-maxdepth','3','-type','f','-name','*tar.gz'],capture_output=True,text=True).stdout[-16000:]
out['recent']=subprocess.run(['find','/opt/wg-platform/backups','-maxdepth','2','-type','d'],capture_output=True,text=True).stdout[-14000:]
for f in ['src/a-token-api.js','src/a-token-transfer-service.js','public/js/a-token-transfer.js']:
 p=r/f;out[f]={'mtime':p.stat().st_mtime,'source':p.read_text()}
p=pathlib.Path('/opt/wg-platform/logs/server.stderr.log');out['errors']=p.read_text(errors='replace')[-18000:]
print(json.dumps(out,ensure_ascii=False))
