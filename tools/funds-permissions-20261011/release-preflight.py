import base64, datetime, gzip, hashlib, json, pathlib, subprocess, urllib.request
root=pathlib.Path('/opt/wg-platform')
names=['src/admin-security.js', 'src/a-token-admin-api.js', 'src/funds-admin-api.js', 'src/server.js', 'public/admin.html', 'public/funds-admin.html', 'public/js/operator-admin.js', 'public/js/funds-admin.js']
out={'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':{},'protected':{}}
for name in names:
    data=(root/name).read_bytes()
    out['files'][name]={'sha256':hashlib.sha256(data).hexdigest(),'gzip_base64':base64.b64encode(gzip.compress(data)).decode('ascii')}
for path in list((root/'src').rglob('*'))+list((root/'public').rglob('*'))+[root/'.env',root/'package.json',root/'package-lock.json']:
    if path.is_file() and path.relative_to(root).as_posix() not in names:
        out['protected'][path.relative_to(root).as_posix()]=hashlib.sha256(path.read_bytes()).hexdigest()
out['service']=subprocess.run(['systemctl','show','wg-platform','--property=MainPID,ActiveState,SubState'],check=True,capture_output=True,text=True,timeout=5).stdout
with urllib.request.urlopen('http://127.0.0.1:8082/api/wallet/session',timeout=5) as response:
    out['health']={'status':response.code,'authenticated':json.load(response).get('authenticated')}
print(json.dumps(out))
