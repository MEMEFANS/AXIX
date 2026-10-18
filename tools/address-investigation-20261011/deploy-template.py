import base64,gzip,json,hashlib,os,pathlib,tarfile,subprocess,datetime,time,urllib.request,http.cookiejar
root=pathlib.Path('/opt/wg-platform')
release='security-social-xss-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
files=json.loads(gzip.decompress(base64.b64decode('__PAYLOAD__')))
stage=pathlib.Path('/tmp')/release;stage.mkdir()
allowed={'src/lottery-service.js','src/a-token-api.js','src/withdrawal-payout-service.js','public/js/admin-lottery.js','public/js/admin-community.js','public/admin.html'}
assert set(files)==allowed
for name,item in files.items():
    if hashlib.sha256((root/name).read_bytes()).hexdigest()!=item['before']:raise RuntimeError('Production changed: '+name)
    body=base64.b64decode(item['body']);assert hashlib.sha256(body).hexdigest()==item['after']
    p=stage/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(body)
    if name.endswith('.js'):subprocess.run(['node','--input-type=module','--check'],input=body,check=True,capture_output=True)
backup=root/'backups'/release;backup.mkdir(parents=True)
with tarfile.open(backup/'previous.tar.gz','w:gz') as tar:
    for name in files:tar.add(root/name,arcname=name)

env={}
for line in (root/'.env').read_text().splitlines():
    line=line.strip()
    if line and not line.startswith('#') and '=' in line:
        k,v=line.split('=',1);env[k.strip()]=v.strip().strip('"').strip("'")
base='http://127.0.0.1:8082'
jar=http.cookiejar.CookieJar();opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(path,body=None,method=None):
    req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers={'Content-Type':'application/json','Origin':base})
    with opener.open(req,timeout=5) as r:return json.load(r)
previous_pid=subprocess.run(['systemctl','show','wg-platform','--property=MainPID','--value'],capture_output=True,text=True,check=True).stdout.strip()
switched=False
try:
    for name in files:
        p=root/name;temp=p.with_name(p.name+'.next-'+release);temp.write_bytes((stage/name).read_bytes());os.chmod(temp,p.stat().st_mode);os.chown(temp,p.stat().st_uid,p.stat().st_gid);os.replace(temp,p)
    switched=True
    subprocess.run(['systemctl','restart','wg-platform'],check=True,timeout=35,capture_output=True)
    ready=False
    for attempt in range(10):
        try:
            status=call('/api/wallet/session')
            if status.get('authenticated') is False:ready=True;break
        except Exception:time.sleep(1)
    assert ready,'Service did not become ready'
    assert call('/api/admin/session').get('authenticated') is False
    for name,item in files.items():assert hashlib.sha256((root/name).read_bytes()).hexdigest()==item['after']
    subprocess.run(['systemctl','is-active','--quiet','wg-platform'],check=True)
    current_pid=subprocess.run(['systemctl','show','wg-platform','--property=MainPID','--value'],capture_output=True,text=True,check=True).stdout.strip()
    assert current_pid!=previous_pid,'Expected process restart'
    print(json.dumps({'deployed':True,'release':release,'backup':str(backup/'previous.tar.gz'),'files':list(files),'admin_sessions_reset_on_restart':True,'previous_pid':previous_pid,'current_pid':current_pid,'service':subprocess.run(['systemctl','show','wg-platform','--property=MainPID,ActiveState,SubState'],capture_output=True,text=True).stdout,'completed_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2))
except Exception:
    if switched:
        with tarfile.open(backup/'previous.tar.gz') as tar:
            for name in files:
                p=root/name;temp=p.with_name(p.name+'.rollback-'+release);temp.write_bytes(tar.extractfile(name).read());os.chmod(temp,p.stat().st_mode);os.chown(temp,p.stat().st_uid,p.stat().st_gid);os.replace(temp,p)
        subprocess.run(['systemctl','restart','wg-platform'],timeout=35,capture_output=True)
    raise
