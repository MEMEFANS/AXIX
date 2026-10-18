import base64, datetime, gzip, hashlib, json, pathlib, subprocess
root=pathlib.Path('/opt/wg-platform')
names=['src/wallet-service.js','src/server.js','public/js/operator-admin.js','public/js/admin-lottery.js','public/js/admin-agents.js','public/admin.html']
files={}
for name in names:
    data=(root/name).read_bytes()
    files[name]={'sha256':hashlib.sha256(data).hexdigest(),'gzip_base64':base64.b64encode(gzip.compress(data)).decode('ascii')}
protected={}
for directory in ['src','public']:
    for item in (root/directory).rglob('*'):
        name=item.relative_to(root).as_posix()
        if item.is_file() and name not in names: protected[name]=hashlib.sha256(item.read_bytes()).hexdigest()
for name in ['.env','package.json','package-lock.json']:
    protected[name]=hashlib.sha256((root/name).read_bytes()).hexdigest()
output=subprocess.run(['systemctl','show','wg-platform','--property=MainPID,ActiveState,SubState'],check=True,capture_output=True,text=True,timeout=8).stdout
service=dict(line.split('=',1) for line in output.splitlines() if '=' in line)
assert service['ActiveState']=='active' and service['SubState']=='running'
print(json.dumps({'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':files,'protected':protected,'service':service}))
