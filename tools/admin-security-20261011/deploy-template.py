import base64
import datetime
import gzip
import hashlib
import http.cookiejar
import json
import os
import pathlib
import sqlite3
import stat
import subprocess
import tarfile
import time
import urllib.error
import urllib.request

root = pathlib.Path('/opt/wg-platform')
release = 'admin-security-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')
payload = json.loads(gzip.decompress(base64.b64decode('__PAYLOAD__')))
files, protected = payload['files'], payload['protected']
assert len(files) == 17 and len(protected) >= 200
assert 'src/wallet-service.js' in protected and '.env' in protected
order = sorted(files, key=lambda name:(name.endswith('.html'), name))
backup = root / 'backups' / release
candidate = backup / 'candidate'
originals, metadata = {}, {}
stopped = switched = False
base = 'http://127.0.0.1:8082'
sha = lambda data:hashlib.sha256(data).hexdigest()

def service():
    raw = subprocess.run(['systemctl','show','wg-platform','--property=MainPID,ActiveState,SubState'],check=True,capture_output=True,text=True,timeout=5).stdout
    return dict(line.split('=',1) for line in raw.splitlines() if '=' in line)

def guard(which):
    for name,item in files.items():
        path = root / name
        actual = sha(path.read_bytes()) if path.is_file() else None
        if actual != item[which]:
            raise RuntimeError('Production file changed: ' + name)
    for name,expected in protected.items():
        if sha((root / name).read_bytes()) != expected:
            raise RuntimeError('Protected file changed: ' + name)

def readonly():
    db = sqlite3.connect('file:' + str(root / 'wg-platform.sqlite') + '?mode=ro',uri=True)
    db.execute('PRAGMA query_only=ON')
    db.execute('BEGIN')
    return db

def snapshot(db):
    result = {}
    tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    for table in tables:
        quoted = '"' + table.replace('"','""') + '"'
        digest, count = hashlib.sha256(), 0
        for row in db.execute('SELECT * FROM ' + quoted):
            for value in row:
                data = value if isinstance(value,bytes) else json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()
                digest.update(len(data).to_bytes(8,'big')); digest.update(data)
            digest.update(b'\n'); count += 1
        result[table] = {'count':count,'sha256':digest.hexdigest()}
    return result

def wallet_meta(db):
    row = db.execute("SELECT payload_json FROM service_settings WHERE setting_key='wallet_meta'").fetchone()
    if row is None:
        raise RuntimeError('Missing wallet safety settings')
    return json.loads(row[0])

def replace(name,data,suffix):
    target = root / name
    temp = target.with_name(target.name + '.' + suffix + '-' + release)
    with temp.open('xb') as output:
        output.write(data); output.flush(); os.fsync(output.fileno())
    info = metadata[name]
    os.chmod(temp,stat.S_IMODE(info.st_mode) if originals[name] is not None else 0o644)
    os.chown(temp,info.st_uid,info.st_gid)
    os.replace(temp,target)

def credentials():
    pid = service()['MainPID']
    environment = dict(item.decode().split('=',1) for item in pathlib.Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in item)
    code = """import {getConfig} from './src/config.js';const cfg=getConfig();const defaults=['127.0.0.1','localhost','::1'].includes(String(cfg.host||'').toLowerCase());console.log(JSON.stringify({username:process.env.PLATFORM_ADMIN_USERNAME||(defaults?'admin':''),password:process.env.PLATFORM_ADMIN_PASSWORD||(defaults?'WG-Admin-2026':''),fundsToken:process.env.WALLET_ADMIN_TOKEN||''}));"""
    raw = subprocess.run(['node','--input-type=module','-e',code],cwd=root,env=environment,check=True,capture_output=True,text=True,timeout=10).stdout
    result = json.loads(raw)
    if not all(result.values()):
        raise RuntimeError('Admin credentials missing')
    return result

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        return None

def request(opener,uri,expected=200,headers=None,body=None):
    headers = dict(headers or {})
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(base+uri,headers=headers,data=json.dumps(body).encode() if body is not None else None)
    try:
        response = opener.open(req,timeout=8)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        data, status, returned = response.read(),response.code,dict(response.headers)
    if status != expected:
        raise RuntimeError('Origin check failed (' + str(status) + '): ' + uri)
    return data,returned

def verify():
    checked = []
    opener = urllib.request.build_opener(NoRedirect())
    mapping = {
        '/':'public/index.html', '/admin.html':'public/admin.html', '/funds-admin.html':'public/funds-admin.html',
        '/js/operator-admin.js?v=20261011-security-2':'public/js/operator-admin.js',
        '/js/admin-lottery.js?v=20261011-security-2':'public/js/admin-lottery.js',
        '/js/admin-dialogs.js?v=20261011-security-1':'public/js/admin-dialogs.js',
        '/js/funds-admin.js?v=20261011-security-1':'public/js/funds-admin.js',
        '/styles/funds-admin.css?v=20261011-security-1':'public/styles/funds-admin.css',
        '/js/support-chat.js?v=20261011-security-2':'public/js/support-chat.js',
        '/js/page-loader.js?v=20261011-pages-security-2':'public/js/page-loader.js',
        '/sw.js?v=9':'public/sw.js', '/js/withdraw-admin.js':'public/js/withdraw-admin.js',
    }
    for uri,name in mapping.items():
        data,headers = request(opener,uri)
        if sha(data) != files[name]['after']:
            raise RuntimeError('Origin content mismatch: ' + uri)
        if uri in ['/admin.html','/funds-admin.html']:
            csp = headers.get('Content-Security-Policy','')
            if "'unsafe-inline'" in csp.split('script-src',1)[1].split(';',1)[0] or headers.get('Cache-Control') != 'no-store':
                raise RuntimeError('Admin response security mismatch')
        checked.append({'uri':uri,'status':200,'sha256':sha(data)})
    _,headers = request(opener,'/withdraw-admin.html',302)
    if headers.get('Location') != '/funds-admin.html':
        raise RuntimeError('Legacy funds redirect failed')
    for uri in ['/%61dmin.html','/%66unds-admin.html']:
        _,headers = request(opener,uri)
        if headers.get('Cache-Control') != 'no-store' or "'unsafe-inline'" in headers['Content-Security-Policy'].split('script-src',1)[1].split(';',1)[0]:
            raise RuntimeError('Encoded admin response security failed')
    login = credentials()
    funds_headers = {'X-Wallet-Admin-Token':login['fundsToken']}
    data,_ = request(opener,'/api/wallet/admin/session',headers=funds_headers)
    if json.loads(data).get('authenticated') is not True:
        raise RuntimeError('Funds token login failed')
    data,_ = request(opener,'/api/wallet/admin/withdrawal-automation',headers=funds_headers)
    settings = json.loads(data)
    if settings.get('enabled') is not False:
        raise RuntimeError('Automatic withdrawal state changed')
    for uri in ['/api/wallet/admin/test-credits','/api/wallet/admin/withdrawals']:
        data,_ = request(opener,uri,headers=funds_headers)
        if not isinstance(json.loads(data).get('items'),list):
            raise RuntimeError('Funds listing invalid')
    request(opener,'/api/wallet/admin/session',401)
    request(opener,'/api/wallet/admin/session',403,headers={**funds_headers,'Origin':'https://unrelated.example'})
    jar = http.cookiejar.CookieJar()
    operator = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    request(operator,'/api/admin/login',body={'username':login['username'],'password':login['password']})
    try:
        for uri in ['/api/admin/test-credits','/api/admin/withdrawals','/api/admin/withdrawal-automation']:
            data,_ = request(operator,uri,403)
            if json.loads(data).get('code') != 'FUNDS_ADMIN_REQUIRED':
                raise RuntimeError('Legacy funds access not blocked')
        request(operator,'/api/wallet/admin/test-credits',401)
        data,_ = request(operator,'/api/admin/lottery/social')
        records = json.loads(data)['list']
        for record in records:
            if record.get('screenshotSafe') is False and record.get('screenshotUrl'):
                raise RuntimeError('Unsafe screenshot was not suppressed')
        script_ids = {'ss_3ca9f7559510856c8311','ss_f0178e4ea0f6a05e8e26'}
        matches = [r for r in records if r['id'] in script_ids]
        if len(matches) != 2 or any(r.get('screenshotSafe') is not False or r.get('screenshotUrl') for r in matches):
            raise RuntimeError('Known historical script suppression failed')
    finally:
        request(operator,'/api/admin/logout',body={})
    return {'static':checked,'operator_login_verified':True,'funds_token_verified':True,
            'operator_cookie_denied_funds_access':True,'legacy_funds_api_denied':True,
            'cross_site_funds_denied':True,'social_records_checked':len(records),
            'unsafe_images_suppressed':sum(r.get('screenshotSafe') is False for r in records),
            'historical_script_images_blocked':len(matches),'automatic_withdrawal_enabled':False}

def verify_candidate_on_copy():
    directory = backup / 'isolated-verification'
    directory.mkdir(mode=0o700)
    db = readonly()
    dest = sqlite3.connect(str(directory / 'wg-platform.sqlite'))
    db.backup(dest); dest.close(); db.close()
    os.chmod(directory / 'wg-platform.sqlite',0o600)
    code = r"""
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [root,stage,copy] = process.argv.slice(1);
const uri=(folder,name)=>pathToFileURL(path.join(folder,'src',name)).href;
const {createWalletService}=await import(uri(root,'wallet-service.js'));
const {closeDatabase}=await import(uri(root,'database.js'));
const {createFundsAdminApi}=await import(uri(stage,'funds-admin-api.js'));
const {createLotteryService}=await import(uri(stage,'lottery-service.js'));
try {
 const walletService=createWalletService({dataRoot:copy,depositAddress:'0x'+'d'.repeat(40),networks:[]});
 const api=createFundsAdminApi({walletService,payoutService:{status:()=>({enabled:false,configured:false})},send:(res,status,payload)=>Object.assign(res,{status,payload}),readBody:()=>{throw Error('Read-only verification')},isSameOrigin:()=>true,allowRequest:()=>true,getToken:()=> 'ISOLATED_READONLY_CANDIDATE'});
 const res={setHeader(){}};
 await api.handle({url:'/api/wallet/admin/test-credits',method:'GET',headers:{'x-wallet-admin-token':'ISOLATED_READONLY_CANDIDATE'}},res,'/api/wallet/admin/test-credits');
 assert.equal(res.status,200);assert(Array.isArray(res.payload.items));
 const count=Number(walletService.database.db.prepare('SELECT COUNT(*) AS n FROM balance_adjustments').get().n);
 assert.equal(res.payload.items.length,Math.min(200,count));
 assert(res.payload.items.every(item=>item.id && item.wallet && typeof item.amount==='string'));
 const lottery=createLotteryService({database:walletService.database,walletService});
 const social=lottery.adminListSocial('',200);
 for(const id of ['ss_3ca9f7559510856c8311','ss_f0178e4ea0f6a05e8e26']){
   const row=social.find(item=>item.id===id);assert(row);assert.equal(row.screenshotSafe,false);assert.equal(row.screenshotUrl,'');
 }
 console.log(JSON.stringify({isolatedDatabase:true,readOnlyCandidateApi:true,adjustmentsChecked:res.payload.items.length,socialRecordsChecked:social.length,historicalScriptsSuppressed:true}));
} catch(error) {
 console.log(JSON.stringify({error:String(error.message).slice(0,300)}));process.exitCode=1;
} finally {closeDatabase(copy);}
"""
    checked = subprocess.run(['node','--input-type=module','-e',code,str(root),str(candidate),str(directory)],cwd=root,capture_output=True,text=True,timeout=35)
    if checked.returncode:
        raise RuntimeError('Isolated candidate check failed: ' + checked.stdout[-400:])
    result = json.loads(checked.stdout)
    (backup / 'candidate-verification.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result

try:
    guard('before')
    previous = service()
    if previous.get('ActiveState') != 'active' or previous.get('SubState') != 'running':
        raise RuntimeError('Production service is not running')
    credentials()
    db = readonly()
    if wallet_meta(db)['withdrawalAutomation']['enabled'] is not False:
        raise RuntimeError('Unexpected automatic withdrawal state; refusing to alter it')
    db.close()
    backup.mkdir(parents=True,mode=0o700)
    for name in order:
        data = base64.b64decode(files[name]['body'],validate=True)
        if sha(data) != files[name]['after']:
            raise RuntimeError('Candidate hash mismatch: ' + name)
        path = candidate / name
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(data)
        if name.endswith('.js'):
            result = subprocess.run(['node','--input-type=module','--check'],input=data,capture_output=True,timeout=5)
            if result.returncode:
                raise RuntimeError('Candidate syntax failed: '+name)
        target = root / name
        originals[name] = target.read_bytes() if target.exists() else None
        metadata[name] = target.stat() if target.exists() else target.parent.stat()
    candidate_verification = verify_candidate_on_copy()
    guard('before')
    with tarfile.open(backup / 'previous.tar.gz','w:gz') as archive:
        for name in order:
            if originals[name] is not None:
                archive.add(root / name,arcname=name)
    (backup / 'source-manifest.json').write_text(json.dumps({name:{k:v for k,v in item.items() if k!='body'} for name,item in files.items()},indent=2),encoding='utf-8')
    stopped = True
    subprocess.run(['systemctl','stop','wg-platform'],check=True,capture_output=True,timeout=10)
    guard('before')
    db = readonly()
    dest = sqlite3.connect(str(backup / 'before.sqlite'))
    db.backup(dest); dest.close()
    os.chmod(backup / 'before.sqlite',0o600)
    before_snapshot, before_meta = snapshot(db),wallet_meta(db)
    db.close()
    switched = True
    for name in order:
        replace(name,(candidate / name).read_bytes(),'next')
    guard('after')
    db = readonly()
    if snapshot(db) != before_snapshot:
        raise RuntimeError('Database changed while the service was stopped')
    db.close()
    subprocess.run(['systemctl','start','wg-platform'],check=True,capture_output=True,timeout=10)
    stopped = False
    ready = False
    for attempt in range(30):
        try:
            with urllib.request.urlopen(base+'/api/wallet/session',timeout=1) as response:
                if json.load(response).get('authenticated') is False:
                    ready = True; break
        except Exception:
            time.sleep(0.3)
    if not ready:
        raise RuntimeError('Application readiness failed')
    current = service()
    if current.get('ActiveState') != 'active' or current.get('SubState') != 'running' or current.get('MainPID') == previous.get('MainPID'):
        raise RuntimeError('Restart did not produce a running new process')
    verification = verify()
    guard('after')
    db = readonly()
    if wallet_meta(db) != before_meta:
        raise RuntimeError('Withdrawal settings or frozen accounts changed')
    after_snapshot = snapshot(db); db.close()
    out = {'deployed':True,'release':release,'backup_directory':str(backup),
           'completed_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'files':order,'service':current,'service_restarted':True,'protected_files_unchanged':len(protected),
           'env_unchanged':True,'wallet_service_unchanged':True,'database_tables_checked':len(before_snapshot),
           'ledger_unchanged_during_file_switch':True,'database_tables_changed_after_normal_service_resumed':[name for name in before_snapshot if before_snapshot[name]!=after_snapshot.get(name)],
           'database_restored':False,'withdrawal_settings_and_frozen_accounts_unchanged':True,
           'candidate_verification':candidate_verification,'verification':verification}
except Exception as error:
    rollback_errors = []
    if switched:
        try:
            subprocess.run(['systemctl','stop','wg-platform'],check=True,capture_output=True,timeout=10)
            stopped = True
            for name in order:
                if originals[name] is None:
                    (root / name).unlink(missing_ok=True)
                else:
                    replace(name,originals[name],'rollback')
            guard('before')
        except Exception as rollback_error:
            rollback_errors.append(str(rollback_error))
    if stopped:
        try:
            subprocess.run(['systemctl','start','wg-platform'],check=True,capture_output=True,timeout=10)
        except Exception as restart_error:
            rollback_errors.append(str(restart_error))
    out = {'deployed':False,'release':release,'backup_directory':str(backup),'error':str(error),
           'rolled_back':switched and not rollback_errors,'rollback_errors':rollback_errors,'database_restored':False}
if backup.exists():
    (backup / 'deployment-result.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(out,ensure_ascii=False,indent=2))
