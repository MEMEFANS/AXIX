import base64
import gzip
import hashlib
import json
import pathlib
import subprocess

root = pathlib.Path('/opt/wg-platform')
names = ['public/js/a-token-trade.js', 'public/js/page-loader.js', 'public/index.html']
files = {}
for name in names:
    data = (root / name).read_bytes()
    files[name] = {'sha256':hashlib.sha256(data).hexdigest(), 'gzip_base64':base64.b64encode(gzip.compress(data)).decode('ascii')}
protected = {}
for directory in ['src', 'public']:
    for item in sorted((root / directory).rglob('*')):
        name = item.relative_to(root).as_posix()
        if item.is_file() and name not in names:
            protected[name] = hashlib.sha256(item.read_bytes()).hexdigest()
for name in ['.env', 'package.json', 'package-lock.json']:
    if (root / name).is_file():
        protected[name] = hashlib.sha256((root / name).read_bytes()).hexdigest()
output = subprocess.run(['systemctl', 'show', 'wg-platform', '--property=MainPID,ActiveState,SubState'], check=True, capture_output=True, text=True, timeout=8).stdout
service = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
assert service.get('ActiveState') == 'active' and service.get('SubState') == 'running'
print(json.dumps({'files':files, 'protected':protected, 'service':service, 'database_accessed':False}, indent=2))
