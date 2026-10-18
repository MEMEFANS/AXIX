import datetime
import hashlib
import json
import pathlib
import subprocess
import urllib.request

root = pathlib.Path('/opt/wg-platform')
out = {'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'hashes':{}}
for path in list((root/'src').rglob('*')) + list((root/'public').rglob('*')) + [root/'.env',root/'package.json',root/'package-lock.json']:
    if path.is_file():
        out['hashes'][path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
out['service'] = subprocess.run(['systemctl','show','wg-platform','--property=MainPID,ActiveState,SubState'],check=True,capture_output=True,text=True,timeout=5).stdout
with urllib.request.urlopen('http://127.0.0.1:8082/api/wallet/session',timeout=5) as response:
    out['health'] = {'status':response.code,'authenticated':json.load(response).get('authenticated')}
print(json.dumps(out))
