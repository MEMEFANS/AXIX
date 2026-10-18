import datetime
import difflib
import hashlib
import json
import pathlib
import subprocess

audit = pathlib.Path(__file__).resolve().parent
app = audit.parents[1]/'resources/app'
baseline = json.loads((audit/'baseline.json').read_text(encoding='utf-8'))
names = [item['path'] for item in baseline if item['path'].startswith(('src/','public/'))]
assert len(names)==8
files = []
for item in baseline:
    name = item['path']
    before = (audit/'before'/name).read_bytes()
    after = (app/name).read_bytes()
    assert hashlib.sha256(before).hexdigest()==item['before_sha256']
    files.append({**item,'after_sha256':hashlib.sha256(after).hexdigest()})
    target=audit/'review'/(name.replace('/','_')+'.diff')
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(''.join(difflib.unified_diff(before.decode().splitlines(True),after.decode().splitlines(True),fromfile=name+' before',tofile=name+' after')),encoding='utf-8')
    if name.endswith('.js'):
        subprocess.run(['node','--check',str(app/name)],capture_output=True,check=True,timeout=10)
new='test/funds-permissions.test.js'
files.append({'path':new,'before_sha256':None,'after_sha256':hashlib.sha256((app/new).read_bytes()).hexdigest()})
(audit/'manifest.json').write_text(json.dumps({'deployed':False,'files':files},indent=2),encoding='utf-8')
source='''import base64, datetime, gzip, hashlib, json, pathlib, subprocess, urllib.request
root=pathlib.Path('/opt/wg-platform')
names=__NAMES__
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
'''.replace('__NAMES__',repr(names))
(audit/'release-preflight.py').write_text(source,encoding='utf-8')
print('Prepared manifest and preflight for 8 runtime files')
