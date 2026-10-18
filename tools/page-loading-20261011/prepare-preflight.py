import json
import pathlib

root = pathlib.Path(__file__).resolve().parent
app = root.parents[1] / 'resources/app'
manifest = json.loads((app / 'tools/page-loading-20261011/manifest.json').read_text(encoding='utf-8'))
names = [item['path'] for item in manifest]
source = '''import base64
import datetime
import gzip
import hashlib
import json
import pathlib
import subprocess
import urllib.request

root = pathlib.Path('/opt/wg-platform')
names = __NAMES__
out = {'captured_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'files': {}, 'protected': {}, 'static': {}}
for name in names:
    data = (root / name).read_bytes()
    out['files'][name] = {'sha256': hashlib.sha256(data).hexdigest(), 'gzip_base64': base64.b64encode(gzip.compress(data)).decode('ascii')}
protected_paths = list((root / 'src').rglob('*')) + list((root / 'public').rglob('*')) + [root / '.env', root / 'package.json', root / 'package-lock.json']
for path in protected_paths:
    if not path.is_file():
        continue
    name = path.relative_to(root).as_posix()
    if name not in names:
        out['protected'][name] = hashlib.sha256(path.read_bytes()).hexdigest()
    if name.startswith('public/') and path.suffix in ['.js', '.html', '.css']:
        data = path.read_bytes()
        out['static'][name] = {'sha256': hashlib.sha256(data).hexdigest(), 'gzip_base64': base64.b64encode(gzip.compress(data)).decode('ascii')}
out['service'] = subprocess.run(['systemctl', 'show', 'wg-platform', '--property=MainPID,ActiveState,SubState'], check=True, capture_output=True, text=True, timeout=10).stdout
with urllib.request.urlopen('http://127.0.0.1:8082/api/wallet/session', timeout=5) as response:
    out['session_health'] = {'status': response.status, 'authenticated': json.load(response).get('authenticated')}
print(json.dumps(out, ensure_ascii=False))
'''.replace('__NAMES__', repr(names))
compile(source, 'production-preflight.py', 'exec')
(root / 'production-preflight.py').write_text(source, encoding='utf-8')
print('Prepared read-only production capture for ' + str(len(names)) + ' release files')
