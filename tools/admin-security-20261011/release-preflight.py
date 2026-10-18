import base64, datetime, gzip, hashlib, json, pathlib, subprocess, urllib.request
root = pathlib.Path('/opt/wg-platform')
names = ['src/server.js', 'src/lottery-service.js', 'src/admin-security.js', 'src/funds-admin-api.js', 'public/admin.html', 'public/withdraw-admin.html', 'public/funds-admin.html', 'public/js/admin-lottery.js', 'public/js/operator-admin.js', 'public/js/admin-dialogs.js', 'public/js/funds-admin.js', 'public/js/withdraw-admin.js', 'public/js/support-chat.js', 'public/js/page-loader.js', 'public/index.html', 'public/sw.js', 'public/styles/funds-admin.css']
out = {'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'files':{}, 'protected':{}}
for name in names:
    path = root / name
    data = path.read_bytes() if path.is_file() else None
    out['files'][name] = {'sha256':hashlib.sha256(data).hexdigest(), 'gzip_base64':base64.b64encode(gzip.compress(data)).decode('ascii')} if data is not None else {'sha256':None}
for path in list((root / 'src').rglob('*')) + list((root / 'public').rglob('*')) + [root / '.env', root / 'package.json', root / 'package-lock.json']:
    if path.is_file() and path.relative_to(root).as_posix() not in names:
        out['protected'][path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
out['service'] = subprocess.run(['systemctl','show','wg-platform','--property=MainPID,ActiveState,SubState'],check=True,capture_output=True,text=True,timeout=5).stdout
with urllib.request.urlopen('http://127.0.0.1:8082/api/wallet/session',timeout=5) as response:
    out['health'] = {'status':response.status,'authenticated':json.load(response).get('authenticated')}
print(json.dumps(out))
