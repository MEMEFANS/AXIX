import pathlib,json,hashlib,base64,gzip,os,sqlite3,datetime,subprocess,tarfile,time,urllib.request,http.cookiejar
from decimal import Decimal, getcontext
getcontext().prec=70
root=pathlib.Path('/opt/wg-platform')
release='aix-reporting-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')
payload=json.loads(gzip.decompress(base64.b64decode('__PAYLOAD__')))
files=payload['files'];protected=payload['protected']
allowed={'src/platform-service.js','src/server.js','src/a-token-income.js','src/a-token-revenue-service.js','src/a-token-admin-income.js','public/js/operator-admin.js','public/admin.html'}
assert set(files)==allowed
stage=root/'backups'/(release+'-stage');stage.mkdir(parents=True,mode=0o700)
backup=root/'backups'/release;backup.mkdir(mode=0o700)
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
def guard():
    for name,item in files.items():
        if digest(root/name)!=item['before']:raise RuntimeError('Production baseline changed: '+name)
    for name,value in protected.items():
        if digest(root/name)!=value:raise RuntimeError('Protected source changed: '+name)
guard()
for name,item in files.items():
    data=base64.b64decode(item['body']);assert hashlib.sha256(data).hexdigest()==item['after']
    p=stage/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
    if name.endswith('.js'):
        result=subprocess.run(['node','--input-type=module','--check'],input=data,capture_output=True,timeout=10)
        if result.returncode:raise RuntimeError('Candidate syntax failed: '+name)
env_digest=digest(root/'.env')
def readonly():
    db=sqlite3.connect('file:'+str(root/'wg-platform.sqlite')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');return db
def balance_snapshot(db):
    return {r['address'].lower():json.dumps(json.loads(r['balances_json']),sort_keys=True,separators=(',',':')) for r in db.execute('SELECT address,balances_json FROM wallet_users')}
def rewards_snapshot(db):
    out={}
    for table in ['a_token_miner_releases','a_token_stake_rewards','a_token_team_rewards','a_token_direct_count_rewards']:
        rows=[list(r) for r in db.execute('SELECT id,amount_units FROM '+table+' ORDER BY id')]
        out[table]={'count':len(rows),'sha256':hashlib.sha256(json.dumps(rows,separators=(',',':')).encode()).hexdigest()}
    return out
previous_pid=subprocess.run(['systemctl','show','wg-platform','--property=MainPID','--value'],capture_output=True,text=True,check=True,timeout=10).stdout.strip()
previous_stats=None;switched=False;stopped=False;logged=False
base='http://127.0.0.1:8082';jar=http.cookiejar.CookieJar();opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(path,body=None):
    req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json','Origin':base})
    with opener.open(req,timeout=12) as r:return json.load(r)
try:
    subprocess.run(['systemctl','stop','wg-platform'],check=True,capture_output=True,timeout=25);stopped=True
    guard()
    with tarfile.open(backup/'previous.tar.gz','w:gz') as tar:
        for name in files:
            if (root/name).exists():tar.add(root/name,arcname=name)
    db=readonly();dest=sqlite3.connect(str(backup/'before.sqlite'));db.backup(dest);dest.close()
    before_balances=balance_snapshot(db);before_rewards=rewards_snapshot(db);db.close()
    (backup/'source-manifest.json').write_text(json.dumps({name:{k:v for k,v in item.items() if k!='body'} for name,item in files.items()},indent=2))
    # Mark the switch before the first replacement, so partial replacement also
    # restores all previous files if any step fails. Database is never restored.
    switched=True
    for name in files:
        p=root/name;temp=p.with_name(p.name+'.next-'+release);temp.write_bytes((stage/name).read_bytes())
        reference=p if p.exists() else root/'src/a-token-income.js'
        stat=reference.stat();os.chmod(temp,stat.st_mode);os.chown(temp,stat.st_uid,stat.st_gid);os.replace(temp,p)
    subprocess.run(['systemctl','start','wg-platform'],check=True,capture_output=True,timeout=25);stopped=False
    ready=False
    for attempt in range(20):
        try:
            if call('/api/wallet/session').get('authenticated') is False:ready=True;break
        except Exception:time.sleep(0.5)
    if not ready:raise RuntimeError('Service readiness failed')
    assert call('/api/admin/session').get('authenticated') is False
    assert digest(root/'.env')==env_digest
    for name,item in files.items():assert digest(root/name)==item['after'],'Release hash mismatch: '+name
    for name,value in protected.items():assert digest(root/name)==value,'Protected file changed: '+name
    db=readonly();after_balances=balance_snapshot(db);after_rewards=rewards_snapshot(db)
    balance_changes=[w for w,b in before_balances.items() if after_balances.get(w)!=b]
    # A display-only release must not credit accounts or issue reward rows.
    assert not balance_changes,'Existing balances changed during restart'
    assert after_rewards==before_rewards,'Reward rows changed during restart'
    db.close()
    env={}
    for line in (root/'.env').read_text().splitlines():
        line=line.strip()
        if line and not line.startswith('#') and '=' in line:
            k,v=line.split('=',1);env[k.strip()]=v.strip().strip('"').strip("'")
    assert call('/api/admin/login',{'username':env['PLATFORM_ADMIN_USERNAME'],'password':env['PLATFORM_ADMIN_PASSWORD']}).get('authenticated',True);logged=True
    verification=[]
    for wallet in ['0x968acf8d6111b7668d730641d86efaec0f6b48a6','0xc6da1e64eca3cb29e160fd72a1787a6e9e40a11d','0x436252b4759eee30066a0d1101911caa7a63ccf2']:
        detail=call('/api/admin/users/'+wallet+'/detail');detail=detail.get('detail',detail)
        db=readonly()
        rows=db.execute('SELECT amount_units FROM a_token_team_rewards WHERE recipient_wallet=? COLLATE NOCASE',(wallet,)).fetchall()
        miner=db.execute('SELECT amount_units FROM a_token_miner_releases WHERE wallet=? COLLATE NOCASE',(wallet,)).fetchall()
        stake=db.execute('SELECT amount_units,payload_json FROM a_token_stake_rewards WHERE wallet=? COLLATE NOCASE',(wallet,)).fetchall()
        raw_balance=json.loads(db.execute('SELECT balances_json FROM wallet_users WHERE address=? COLLATE NOCASE',(wallet,)).fetchone()[0])['A']
        units=lambda amount:int(Decimal(str(amount))*Decimal(10**18))
        assert detail['teamRewards']['count']==len(rows)
        assert units(detail['teamRewards']['total'])==sum(int(r[0]) for r in rows)
        assert units(detail['miners']['totalReleased'])==sum(int(r[0]) for r in miner)
        assert units(detail['stakes']['totalCredited'])==sum(int(r[0]) for r in stake)
        assert units(detail['aixBalance'])==int(raw_balance)
        explicit=all('interestUnits' in json.loads(r['payload_json']) for r in stake)
        if explicit:
            assert units(detail['stakes']['totalEarned'])==sum(int(json.loads(r['payload_json'])['interestUnits']) for r in stake)
            assert units(detail['stakes']['principalReturned'])==sum(int(json.loads(r['payload_json'])['principalUnits']) for r in stake)
        verification.append({'wallet':wallet,'team':detail['teamRewards'],'stakes':{k:v for k,v in detail['stakes'].items() if k!='items'},'principal_interest_checked':explicit,'aix_balance_matches':True});db.close()
    call('/api/admin/logout',{});logged=False
    static={}
    for uri,name in [('/admin.html','public/admin.html'),('/js/operator-admin.js?v=45-assets-20261011','public/js/operator-admin.js')]:
        with urllib.request.urlopen(base+uri,timeout=10) as r:
            body=r.read();assert hashlib.sha256(body).hexdigest()==files[name]['after']
            static[uri]={'status':r.status,'sha256':hashlib.sha256(body).hexdigest()}
    subprocess.run(['systemctl','is-active','--quiet','wg-platform'],check=True,capture_output=True,timeout=10)
    pid=subprocess.run(['systemctl','show','wg-platform','--property=MainPID','--value'],capture_output=True,text=True,check=True,timeout=10).stdout.strip();assert pid!=previous_pid
    out={'deployed':True,'release':release,'backup_directory':str(backup),'completed_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':list(files),'service':subprocess.run(['systemctl','show','wg-platform','--property=MainPID,ActiveState,SubState'],capture_output=True,text=True,check=True,timeout=10).stdout,'balances_checked':len(before_balances),'existing_balance_changes':balance_changes,'reward_rows_unchanged':True,'protected_sources_unchanged':True,'env_unchanged':True,'admin_verification':verification,'static':static}
    (backup/'deployment-result.json').write_text(json.dumps(out,ensure_ascii=False,indent=2));print(json.dumps(out,ensure_ascii=False,indent=2))
except Exception as error:
    if logged:
        try:call('/api/admin/logout',{})
        except Exception:pass
    rolled_back=False
    if switched:
        subprocess.run(['systemctl','stop','wg-platform'],capture_output=True,timeout=25)
        with tarfile.open(backup/'previous.tar.gz') as tar:
            for name,item in files.items():
                p=root/name
                if item['before'] is None:
                    if p.exists():p.unlink()
                else:
                    temp=p.with_name(p.name+'.rollback-'+release);temp.write_bytes(tar.extractfile(name).read());stat=p.stat();os.chmod(temp,stat.st_mode);os.chown(temp,stat.st_uid,stat.st_gid);os.replace(temp,p)
        subprocess.run(['systemctl','start','wg-platform'],capture_output=True,timeout=25);rolled_back=True
    elif stopped:subprocess.run(['systemctl','start','wg-platform'],capture_output=True,timeout=25)
    out={'deployed':False,'release':release,'rolled_back':rolled_back,'backup_directory':str(backup),'error':str(error),'database_restored':False}
    (backup/'deployment-result.json').write_text(json.dumps(out,ensure_ascii=False,indent=2));print(json.dumps(out,ensure_ascii=False,indent=2))
