import base64, datetime, gzip, hashlib, http.cookiejar, json, os, pathlib, sqlite3, stat, subprocess, tarfile, time, urllib.error, urllib.request

root=pathlib.Path('/opt/wg-platform')
release='admin-speed-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')
payload=json.loads(gzip.decompress(base64.b64decode('__PAYLOAD__')))
files,protected=payload['files'],payload['protected']
assert set(files)=={'src/wallet-service.js','src/server.js','public/js/operator-admin.js','public/js/admin-lottery.js','public/js/admin-agents.js','public/admin.html'}
assert len(protected)>200 and '.env' in protected
order=sorted(files,key=lambda name:(name.endswith('.html'),name))
backup=root/'backups'/release
candidate=backup/'candidate'
originals,metadata={},{}
switched=stopped=False
base='http://127.0.0.1:8082'
sha=lambda data:hashlib.sha256(data).hexdigest()

def service():
    output=subprocess.run(['systemctl','show','wg-platform','--property=MainPID,ActiveState,SubState'],check=True,capture_output=True,text=True,timeout=8).stdout
    return dict(line.split('=',1) for line in output.splitlines() if '=' in line)

def guard(which):
    for name,item in files.items():
        if sha((root/name).read_bytes())!=item[which]: raise RuntimeError('Production file changed: '+name)
    for name,expected in protected.items():
        if sha((root/name).read_bytes())!=expected: raise RuntimeError('Protected file changed: '+name)

def readonly():
    db=sqlite3.connect('file:'+str(root/'wg-platform.sqlite')+'?mode=ro',uri=True,timeout=8)
    db.execute('PRAGMA query_only=ON')
    return db

def wallet_meta():
    with readonly() as db: row=db.execute("SELECT payload_json FROM service_settings WHERE setting_key='wallet_meta'").fetchone()
    if row is None: raise RuntimeError('Wallet safety settings missing')
    return json.loads(row[0])

def ledger_hashes():
    return {name:sha((root/name).read_bytes()) for name in ['wg-platform.sqlite','wg-platform.sqlite-wal'] if (root/name).is_file()}

def replace(name,data,suffix):
    target=root/name; temp=target.with_name(target.name+'.'+suffix+'-'+release)
    with temp.open('xb') as output: output.write(data); output.flush(); os.fsync(output.fileno())
    info=metadata[name]
    os.chmod(temp,stat.S_IMODE(info.st_mode)); os.chown(temp,info.st_uid,info.st_gid); os.replace(temp,target)

def verify_candidate():
    testdir=backup/'isolated-candidate-check'; testdir.mkdir(mode=0o700)
    source=readonly(); dest=sqlite3.connect(str(testdir/'wg-platform.sqlite'))
    source.backup(dest); source.close(); dest.close(); os.chmod(testdir/'wg-platform.sqlite',0o600)
    for entry in (root/'src').iterdir():
        target=candidate/'src'/entry.name
        if not target.exists(): target.symlink_to(entry,target_is_directory=entry.is_dir())
    code=r"""
import assert from 'node:assert/strict';import path from 'node:path';import {pathToFileURL} from 'node:url';
const [root,stage,data]=process.argv.slice(1);
const uri=(folder,name)=>pathToFileURL(path.join(folder,'src',name)).href;
const oldFactory=(await import(uri(root,'wallet-service.js'))).createWalletService;
const newFactory=(await import(uri(stage,'wallet-service.js'))).createWalletService;
const {closeDatabase}=await import(uri(root,'database.js'));
try {
 const previous=oldFactory({dataRoot:data,networks:[]});const candidate=newFactory({dataRoot:data,networks:[]});
 const start=performance.now();const original=previous.adminDashboard();const oldMs=performance.now()-start;
 const newStart=performance.now();const overview=candidate.adminDashboard({includeUsers:false});const newMs=performance.now()-newStart;
 assert.deepEqual(overview.summary,original.summary);assert(!Object.hasOwn(overview,'users'));
 const full=candidate.adminDashboard();assert.equal(full.users.length,original.users.length);
 assert.deepEqual(new Map(full.users.map(u=>[u.address,u])),new Map(original.users.map(u=>[u.address,u])));
 const page=candidate.adminDashboard({limit:50,offset:0});assert.equal(page.usersTotal,full.users.length);assert.deepEqual(page.users,full.users.slice(0,50));
 const next=candidate.adminDashboard({limit:50,offset:50});assert.deepEqual(next.users,full.users.slice(50,100));
 const real=candidate.adminDashboard({limit:50,realOnly:true});assert.equal(real.usersTotal,full.users.filter(u=>u.isRealUser).length);
 assert.deepEqual(candidate.adminListDeposits('',{limit:8}),previous.adminListDeposits().slice(0,8));
 assert.deepEqual(candidate.adminListWithdrawals('',{limit:8}),previous.adminListWithdrawals().slice(0,8));
 assert.deepEqual(candidate.adminDashboard({includeUsers:false}).withdrawalAutomation,original.withdrawalAutomation);
 console.log(JSON.stringify({isolatedDatabase:true,users:full.users.length,summaryUnchanged:true,usersUnchanged:true,withdrawalAutomationUnchanged:true,baselineMilliseconds:Math.round(oldMs),overviewMilliseconds:Math.round(newMs),pageRows:page.users.length}));
} finally {closeDatabase(data);}
"""
    checked=subprocess.run(['node','--input-type=module','-e',code,str(root),str(candidate),str(testdir)],cwd=root,capture_output=True,text=True,timeout=60)
    if checked.returncode: raise RuntimeError('Candidate regression failed: '+checked.stderr[-600:])
    verified=json.loads(checked.stdout)
    (backup/'candidate-verification.json').write_text(json.dumps(verified,indent=2),encoding='utf-8')
    return verified

def credentials():
    pid=service()['MainPID']
    environment=dict(item.decode().split('=',1) for item in pathlib.Path('/proc/'+pid+'/environ').read_bytes().split(b'\0') if b'=' in item)
    code="import {getConfig} from './src/config.js';getConfig();console.log(JSON.stringify({username:process.env.PLATFORM_ADMIN_USERNAME||'admin',password:process.env.PLATFORM_ADMIN_PASSWORD||'WG-Admin-2026',fundsToken:process.env.WALLET_ADMIN_TOKEN||''}));"
    checked=subprocess.run(['node','--input-type=module','-e',code],cwd=root,env=environment,check=True,capture_output=True,text=True,timeout=10)
    result=json.loads(checked.stdout)
    if not all(result.values()): raise RuntimeError('Admin credentials unavailable')
    return result

def request(opener,uri,expected=200,headers=None,body=None):
    headers=dict(headers or {})
    if body is not None: headers['Content-Type']='application/json'
    start=time.monotonic()
    req=urllib.request.Request(base+uri,headers=headers,data=json.dumps(body).encode() if body is not None else None)
    try: response=opener.open(req,timeout=20)
    except urllib.error.HTTPError as error: response=error
    with response: data,status,returned=response.read(),response.code,dict(response.headers)
    if status!=expected: raise RuntimeError('Origin check failed ('+str(status)+'): '+uri)
    return data,returned,round((time.monotonic()-start)*1000)

def verify():
    opener=urllib.request.build_opener(); static=[]
    for uri,name in {'/admin.html':'public/admin.html','/js/operator-admin.js?v=20261012-admin-speed-1':'public/js/operator-admin.js','/js/admin-lottery.js?v=20261012-admin-speed-1':'public/js/admin-lottery.js','/js/admin-agents.js?v=20261012-admin-speed-1':'public/js/admin-agents.js','/funds-admin.html':'public/funds-admin.html'}.items():
        data,headers,ms=request(opener,uri)
        if sha(data)!=(files[name]['after'] if name in files else protected[name]): raise RuntimeError('Origin static mismatch: '+uri)
        if uri.endswith('.html'):
            if headers.get('Cache-Control')!='no-store' or "'unsafe-inline'" in headers.get('Content-Security-Policy','').split('script-src',1)[1].split(';',1)[0]: raise RuntimeError('Admin response security changed')
        static.append({'uri':uri,'status':200,'sha256':sha(data)})
    for uri in ['/api/admin/tokens','/api/admin/users?limit=50','/api/admin/dashboard?view=overview']: request(opener,uri,401)
    login=credentials(); jar=http.cookiejar.CookieJar(); operator=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    request(operator,'/api/admin/login',body={'username':login['username'],'password':login['password']})
    try:
        raw,_,overview_ms=request(operator,'/api/admin/dashboard?view=overview'); overview=json.loads(raw)
        if 'users' in overview: raise RuntimeError('Overview still returns full user list')
        raw,_,users_ms=request(operator,'/api/admin/users?limit=50&offset=0'); page=json.loads(raw)
        if len(page['users'])!=min(50,page['total']) or page['total']!=overview['summary']['walletUsers']: raise RuntimeError('User pagination mismatch')
        raw,_,_=request(operator,'/api/admin/users?limit=50&offset=50'); nextpage=json.loads(raw)
        if len({user['address'] for user in page['users']+nextpage['users']})!=len(page['users'])+len(nextpage['users']): raise RuntimeError('User page overlap')
        if page['users']:
            address=page['users'][0]['address']
            raw,_,_=request(operator,'/api/admin/users?limit=50&q='+address); searched=json.loads(raw)
            if searched['total']!=1 or searched['users'][0]['address']!=address: raise RuntimeError('User search mismatch')
        raw,_,_=request(operator,'/api/admin/tokens'); assert isinstance(json.loads(raw)['tokens'],list)
        for uri in ['/api/admin/test-credits','/api/admin/withdrawals','/api/admin/withdrawal-automation']+['/api/admin/a-token/'+route for route in ['grant','debit','grant-miner','grant-stake','activations/confirm']]:
            raw,_,_=request(operator,uri,403)
            if json.loads(raw).get('code')!='FUNDS_ADMIN_REQUIRED': raise RuntimeError('Operator funds isolation failed')
        for uri in ['/api/wallet/admin/test-credits','/api/wallet/admin/asset-adjustments','/api/wallet/admin/miner-grants']: request(operator,uri,401)
        raw,_,_=request(operator,'/api/admin/lottery/social?status=pending'); social=json.loads(raw)['list']
        if any(row.get('screenshotSafe') is False and row.get('screenshotUrl') for row in social): raise RuntimeError('Unsafe screenshot exposed')
        raw,_,_=request(opener,'/api/wallet/admin/withdrawal-automation',headers={'X-Wallet-Admin-Token':login['fundsToken']})
        if json.loads(raw).get('enabled')!=initial_meta['withdrawalAutomation']['enabled']: raise RuntimeError('Withdrawal automation changed')
    finally: request(operator,'/api/admin/logout',body={})
    return {'static':static,'operatorLogin':True,'overviewMilliseconds':overview_ms,'usersMilliseconds':users_ms,'usersTotal':page['total'],'usersRows':len(page['users']),'paginationAndSearch':True,'fundsPermissions':True,'unsafeScreenshotsSuppressed':True}

try:
    guard('before'); previous=service()
    if previous.get('ActiveState')!='active' or previous.get('SubState')!='running': raise RuntimeError('Production service is not running')
    backup.mkdir(parents=True,mode=0o700)
    for name in order:
        data=base64.b64decode(files[name]['body'],validate=True)
        if sha(data)!=files[name]['after']: raise RuntimeError('Candidate hash mismatch')
        target=candidate/name; target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(data)
        if name.endswith('.js'):
            checked=subprocess.run(['node','--input-type=module','--check'],input=data,capture_output=True,timeout=8)
            if checked.returncode: raise RuntimeError('Candidate syntax failed: '+name)
        originals[name]=(root/name).read_bytes(); metadata[name]=(root/name).stat()
    verified_candidate=verify_candidate()
    with tarfile.open(backup/'previous.tar.gz','w:gz') as archive:
        for name in order: archive.add(root/name,arcname=name)
    (backup/'source-manifest.json').write_text(json.dumps({name:{key:value for key,value in item.items() if key!='body'} for name,item in files.items()},indent=2),encoding='utf-8')
    (backup/'protected-manifest.json').write_text(json.dumps(protected,indent=2),encoding='utf-8')
    guard('before'); stopped=True
    subprocess.run(['systemctl','stop','wg-platform'],check=True,capture_output=True,timeout=15)
    initial_meta=wallet_meta()
    source=readonly(); dest=sqlite3.connect(str(backup/'before.sqlite')); source.backup(dest); source.close(); dest.close(); os.chmod(backup/'before.sqlite',0o600)
    before_hashes=ledger_hashes(); guard('before'); switched=True
    for name in order: replace(name,(candidate/name).read_bytes(),'next')
    guard('after')
    if ledger_hashes()!=before_hashes: raise RuntimeError('Database changed during source switch')
    subprocess.run(['systemctl','start','wg-platform'],check=True,capture_output=True,timeout=15); stopped=False
    ready=False
    for attempt in range(40):
        try:
            with urllib.request.urlopen(base+'/api/wallet/session',timeout=1) as response:
                if json.load(response).get('authenticated') is False: ready=True; break
        except Exception: time.sleep(0.3)
    if not ready: raise RuntimeError('Application readiness failed')
    current=service()
    if current.get('ActiveState')!='active' or current.get('SubState')!='running' or current.get('MainPID')==previous.get('MainPID'): raise RuntimeError('Backend restart failed')
    verification=verify(); guard('after')
    if wallet_meta()!=initial_meta: raise RuntimeError('Withdrawal settings or frozen accounts changed')
    out={'deployed':True,'release':release,'backup_directory':str(backup),'completed_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':order,'service':current,'service_restarted':True,'protected_files_unchanged':len(protected),'env_unchanged':True,'ledger_unchanged_during_file_switch':True,'database_restored':False,'withdrawal_settings_and_frozen_accounts_unchanged':True,'candidate_verification':verified_candidate,'verification':verification}
except Exception as error:
    rollback_errors=[]
    if switched:
        try:
            subprocess.run(['systemctl','stop','wg-platform'],check=True,capture_output=True,timeout=15); stopped=True
            for name in order: replace(name,originals[name],'rollback')
            guard('before')
        except Exception as rollback_error: rollback_errors.append(str(rollback_error))
    if stopped:
        try: subprocess.run(['systemctl','start','wg-platform'],check=True,capture_output=True,timeout=15)
        except Exception as restart_error: rollback_errors.append(str(restart_error))
    out={'deployed':False,'release':release,'backup_directory':str(backup),'error':str(error),'rolled_back':switched and not rollback_errors,'rollback_errors':rollback_errors,'database_restored':False}
if backup.exists(): (backup/'deployment-result.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(out,ensure_ascii=False,indent=2))
