import pathlib, json, hashlib, subprocess, sqlite3, shutil, os, time, urllib.request, urllib.error, http.cookiejar

R=pathlib.Path('/opt/wg-platform')
D=pathlib.Path('/var/lib/wg-platform')
S=pathlib.Path('/opt/wg-security-20261014')
M=json.loads((S/'manifest.json').read_text())
B=pathlib.Path('/root/wg-security-'+time.strftime('%Y%m%d-%H%M%S',time.gmtime()))
files=M['files']
def sha(p, normalized=False):
    b=p.read_bytes()
    return hashlib.sha256(b.replace(b'\r\n',b'\n') if normalized else b).hexdigest()
def run(args,cwd=None,timeout=180):
    p=subprocess.run(args,cwd=cwd,capture_output=True,text=True,timeout=timeout)
    if p.returncode: raise RuntimeError(str(args[:3])+': '+p.stdout[-1800:]+p.stderr[-1000:])
    return p.stdout
def guard():
    for name in files:
        if sha(R/name,True)!=M['old'][name]: raise RuntimeError('Production changed: '+name)
        if sha(S/name)!=M['new'][name]: raise RuntimeError('Candidate hash failed: '+name)
def fingerprint():
    with sqlite3.connect('file:'+str(D/'wg-platform.sqlite')+'?mode=ro',uri=True) as db:
        assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok'
        names=[row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        result={}
        for name in names:
            rows=db.execute('SELECT * FROM "'+name.replace('"','""')+'"').fetchall()
            encoded=sorted(repr(row) for row in rows)
            result[name]={'count':len(rows),'sha':hashlib.sha256('\n'.join(encoded).encode()).hexdigest()}
        return result

B.mkdir(mode=0o700)
out={'backup':str(B),'files':files,'startedAt':time.time()}
def save(): (B/'result.json').write_text(json.dumps(out,ensure_ascii=False,indent=2))
guard()
# Build/test off-line from production. No .env or production database in candidate.
out['install']=run(['npm','ci','--ignore-scripts','--no-fund'],S,240)[-800:]
out['audit']=json.loads(run(['npm','audit','--json'],S,90))['metadata']['vulnerabilities']
for target in ['src/server.js','src/database.js','src/a-token-withdrawal-service.js','src/a-token-claim-service.js','src/a-token-miner-service.js']:
    run(['node','--check',str(S/target)])
# Tests use temporary ledgers. Run under the production service account.
out['regression']=run(['runuser','-u','wg-platform','--','npm','test'],S,240)[-3500:]
out['security']=run(['runuser','-u','wg-platform','--','npm','run','test:claim-security'],S,60)[-1500:]
for test in ['admin-security.test.js','funds-permissions.test.js']:
    out[test]=run(['runuser','-u','wg-platform','--','node','test/'+test],S,60)[-2000:]
save()
guard()
for name in files:
    target=B/'original'/name
    target.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(R/name,target)
out['envHash']=sha(D/'.env')
# Independent rescue timer survives disconnect or a killed deploy process.
rollback=B/'rollback.sh'
rollback.write_text('#!/bin/sh\nset -eu\ntest -f "'+str(B/'success')+'" && exit 0\nsystemctl stop wg-platform\n'+
    '\n'.join('cp -p "'+str(B/'original'/name)+'" "'+str(R/name)+'"' for name in files)+
    '\nif test -d "'+str(B/'node_modules')+'"; then mv "'+str(R/'node_modules')+'" "'+str(B/'failed-node_modules')+'"; mv "'+str(B/'node_modules')+'" "'+str(R/'node_modules')+'"; fi\nsystemctl start wg-platform\n')
rollback.chmod(0o700)
unit='wg-security-rescue-'+B.name
run(['systemd-run','--unit='+unit,'--on-active=10m',str(rollback)])
stopped=False
try:
    run(['systemctl','stop','wg-platform']); stopped=True
    guard()
    out['ledgerBefore']=fingerprint()
    with sqlite3.connect(D/'wg-platform.sqlite') as source,sqlite3.connect(B/'ledger-backup.sqlite') as dest: source.backup(dest)
    (B/'ledger-backup.sqlite').chmod(0o600)
    for name in files:
        target=R/name
        staged=target.with_name(target.name+'.security-next')
        shutil.copyfile(S/name,staged); shutil.copymode(target,staged)
        os.chown(staged,0,0); os.replace(staged,target)
    os.rename(R/'node_modules',B/'node_modules')
    os.rename(S/'node_modules',R/'node_modules')
    assert fingerprint()==out['ledgerBefore'], 'Ledger changed while stopped'
    assert sha(D/'.env')==out['envHash'], 'Configuration changed'
    out['ledgerUnchangedAtSwitch']=True
    for name in files: assert sha(R/name)==M['new'][name]
    run(['systemctl','start','wg-platform'])
    base='http://127.0.0.1:8082'
    def req(route,expected=200,body=None,opener=None,headers=None):
        request=urllib.request.Request(base+route,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json',**(headers or {})})
        try: response=(opener or urllib.request.build_opener()).open(request,timeout=15)
        except urllib.error.HTTPError as e: response=e
        with response: status=response.status; raw=response.read()
        if status!=expected: raise RuntimeError('HTTP '+str(status)+' at '+route)
        return json.loads(raw) if raw.startswith((b'{',b'[')) else None
    for i in range(40):
        try: req('/api/wallet/config'); break
        except Exception:
            if i==39: raise
            time.sleep(2)
    for route in ['/','/api/a-token/plans','/api/wallet/session']: req(route)
    for route in ['/api/admin/dashboard?view=overview','/api/wallet/admin/withdrawals','/api/platform/profile','/api/a-token/withdrawals']: req(route,401)
    # Credentials remain inside this process and never appear in output.
    pid=run(['systemctl','show','wg-platform','-p','MainPID','--value']).strip()
    env=dict(item.decode().split('=',1) for item in pathlib.Path('/proc/'+pid+'/environ').read_bytes().split(b'\0') if b'=' in item)
    code="import {getConfig} from './src/config.js';getConfig();console.log(JSON.stringify({username:process.env.PLATFORM_ADMIN_USERNAME,password:process.env.PLATFORM_ADMIN_PASSWORD,token:process.env.WALLET_ADMIN_TOKEN}));"
    credentials=json.loads(subprocess.check_output(['node','--input-type=module','-e',code],cwd=R,env=env,text=True,timeout=15))
    opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    req('/api/admin/login',body={'username':credentials['username'],'password':credentials['password']},opener=opener)
    req('/api/admin/dashboard?view=overview',opener=opener)
    req('/api/admin/users?limit=5&offset=0',opener=opener)
    req('/api/wallet/admin/withdrawals',headers={'x-wallet-admin-token':credentials['token']})
    req('/api/admin/logout',body={},opener=opener)
    out['readOnlySmokeChecks']=True
    time.sleep(10)
    out['service']=run(['systemctl','show','wg-platform','-p','ActiveState,SubState,MainPID,NRestarts,User'])
    assert 'ActiveState=active' in out['service'] and 'SubState=running' in out['service']
    assert 'NRestarts=0' in out['service']
    assert sha(D/'.env')==out['envHash']
    out['ledgerAfterStartup']=fingerprint()
    out['newHashes']={name:sha(R/name) for name in files}
    out['success']=True; save(); (B/'success').touch()
    run(['systemctl','stop',unit+'.timer'])
    print(json.dumps({'success':True,'backup':str(B),'service':out['service'],'ledgerUnchangedAtSwitch':True,'audit':out['audit']}))
except BaseException as error:
    out['error']=str(error); save()
    if stopped: run([str(rollback)],timeout=120)
    run(['systemctl','stop',unit+'.timer'])
    raise
