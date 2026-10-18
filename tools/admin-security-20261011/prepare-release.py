import json
import pathlib

audit = pathlib.Path(__file__).resolve().parent
manifest = json.loads((audit / 'manifest.json').read_text(encoding='utf-8'))
names = [item['path'] for item in manifest['files'] if item['path'].startswith(('src/', 'public/'))]
assert len(names) == 17
source = '''import base64, datetime, gzip, hashlib, json, pathlib, subprocess, urllib.request
root = pathlib.Path('/opt/wg-platform')
names = __NAMES__
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
'''.replace('__NAMES__', repr(names))
(audit / 'release-preflight.py').write_text(source, encoding='utf-8')
print('Prepared preflight for', len(names), 'runtime files')
