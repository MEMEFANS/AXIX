import base64,gzip,json,hashlib,pathlib,sqlite3,re,datetime,subprocess,os,shutil,time,urllib.request,urllib.error,http.cookiejar,collections
root=pathlib.Path('/opt/wg-platform')
plan=json.loads(gzip.decompress(base64.b64decode('__CLEANUP_PAYLOAD__')))
release='incident-cleanup-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
backup=root/'backups'/release
pattern=r'<script\b|\bon[a-z]+\s*=|javascript\s*:|<iframe\b|<object\b|<embed\b'
targets=set(plan['targets']); target_args=sorted(targets)
assert len(targets)==114 and all(re.fullmatch(r'0x[0-9a-f]{40}',w) for w in targets)
wallet_cols={'wallet','address','from_wallet','to_wallet','recipient_wallet','source_wallet','referrer_wallet','wallet_address','owner_wallet'}
def filehash(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for part in iter(lambda:f.read(1048576),b''):h.update(part)
    return h.hexdigest()
def q(name):return '"'+name.replace('"','""')+'"'
def run(*args,timeout=30):return subprocess.run(args,capture_output=True,text=True,check=True,timeout=timeout)
def save_private(name,data):
    p=backup/name;p.write_text(json.dumps(data,ensure_ascii=False,indent=2));os.chmod(p,0o600)
file=root/'src/wallet-service.js';body=base64.b64decode(plan['file']['body'])
assert filehash(file)==plan['file']['before'],'Production source changed; rescan before cleanup'
assert hashlib.sha256(body).hexdigest()==plan['file']['after']
subprocess.run(['node','--input-type=module','--check'],input=body,capture_output=True,check=True)
assert not (root/'platform-ledger-transaction.json').exists(),'Pending ledger recovery requires reconciliation'
backup.mkdir(parents=True,mode=0o700);os.chmod(backup,0o700)
db=None;committed=False;code_switched=False;stop_attempted=False
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
try:
    stop_attempted=True;run('systemctl','stop','wg-platform',timeout=35)
    assert run('systemctl','show','wg-platform','--property=MainPID','--value').stdout.strip()=='0'
    assert not (root/'platform-ledger-transaction.json').exists(),'Pending ledger recovery requires reconciliation'
    db=sqlite3.connect(str(root/'wg-platform.sqlite'),timeout=10);db.row_factory=sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    dst=sqlite3.connect(str(backup/'before.sqlite'));db.backup(dst);dst.close();os.chmod(backup/'before.sqlite',0o600)
    db_backup_sha=filehash(backup/'before.sqlite')
    legacy_names=['wallet-accounts.json','platform-accounts.json']
    for name in ['src/wallet-service.js']+legacy_names:
        p=root/name
        if p.exists():
            out=backup/name;out.parent.mkdir(parents=True,exist_ok=True,mode=0o700);shutil.copy2(p,out);os.chmod(out,0o600)
    inventory=[]
    for r in db.execute('SELECT id,wallet,status,screenshot_url FROM social_submissions'):
        s=r['screenshot_url'] or ''
        if re.search(pattern,s,re.I):inventory.append({'id':r['id'],'wallet':r['wallet'].lower(),'status':r['status'],'sha256':hashlib.sha256(s.encode()).hexdigest()})
    assert sorted(inventory,key=lambda x:x['id'])==sorted(plan['malicious'],key=lambda x:x['id']),'Malicious inventory changed; refresh required'
    known={'0xd36ddfb9d3fa6b326b49e6eab68c5b961bc3ba59','0xf75a7c032b7a484269ced5663f7fa10acf63b1ac'}
    assert targets=={x['wallet'] for x in inventory}|known
    slots=','.join('?' for _ in targets)
    def where_for(cols):return ' OR '.join('lower('+q(c)+') IN ('+slots+')' for c in cols),target_args*len(cols)
    schema={}
    for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
        t=r[0];cols=[r['name'] for r in db.execute('PRAGMA table_info('+q(t)+')')]
        relevant=[c for c in cols if c in wallet_cols]
        schema[t]={'columns':cols,'wallet_columns':relevant}
    assert {k:v['columns'] for k,v in schema.items()}=={k:v['columns'] for k,v in plan['tables'].items()},'Schema changed'
    fk_before=[tuple(x) for x in db.execute('PRAGMA foreign_key_check')]
    assert not fk_before,'Pre-existing foreign key violations require inspection'
    tickets=[r[0] for r in db.execute('SELECT id FROM support_tickets WHERE lower(wallet) IN ('+slots+')',target_args)]
    selectors={}
    for t,meta in schema.items():
        if meta['wallet_columns']:selectors[t]=where_for(meta['wallet_columns'])
    if tickets:selectors['support_messages']=('ticket_id IN ('+','.join('?' for _ in tickets)+')',tickets)
    # Do not remove a normal user's referral-link row merely because its referrer was blocked.
    cross_referral=db.execute('SELECT COUNT(*) FROM platform_referral_links WHERE lower(wallet) NOT IN ('+slots+') AND lower(referrer_wallet) IN ('+slots+')',target_args*2).fetchone()[0]
    assert cross_referral==0,'Normal referral links need a separate preservation plan'
    def digest_remaining(t,selector=None):
        h=hashlib.sha256();count=0
        sql='SELECT * FROM '+q(t)
        args=[]
        if selector:
            cond,args=selector;sql+=' WHERE NOT COALESCE(('+cond+'),0)'
        for row in db.execute(sql+' ORDER BY rowid',args):
            h.update(json.dumps(dict(row),sort_keys=True,separators=(',',':'),ensure_ascii=False).encode());h.update(b'\n');count+=1
        return {'count':count,'sha256':h.hexdigest()}
    normal_before={t:digest_remaining(t,sel) for t,sel in selectors.items()}
    table_before={t:db.execute('SELECT COUNT(*) FROM '+q(t)).fetchone()[0] for t in schema}
    affected_before={t:db.execute('SELECT COUNT(*) FROM '+q(t)+' WHERE '+sel[0],sel[1]).fetchone()[0] for t,sel in selectors.items()}
    accounts=[];totals=collections.defaultdict(int)
    for r in db.execute('SELECT address,balances_json,payload_json FROM wallet_users WHERE lower(address) IN ('+slots+')',target_args):
        p=json.loads(r['payload_json']);b=p.get('balances',{})
        assert b==json.loads(r['balances_json']),'Balance stores disagree'
        for asset,v in b.items():
            amount=int(v);assert amount>=0;totals[asset]+=amount
        accounts.append({'wallet':r['address'].lower(),'balances':b,'has_balance':any(int(v)!=0 for v in b.values())})
    assert len(accounts)==114,'Account inventory changed'
    points=sum(r[0] for r in db.execute('SELECT points FROM lottery_accounts WHERE lower(wallet) IN ('+slots+')',target_args))
    save_private('evidence-summary.json',{'started_at_utc':started,'targets':target_args,'malicious':inventory,'accounts':accounts,'lottery_points':points,'affected_counts':affected_before,'normal_rows_before':normal_before,'database_sha256':db_backup_sha})
    legacy_updates={}
    for name in legacy_names:
        p=root/name
        if not p.exists():continue
        old=json.loads(p.read_text());new=json.loads(json.dumps(old))
        if name=='wallet-accounts.json':
            new['users']={k:v for k,v in new.get('users',{}).items() if k.lower() not in targets}
            new['sessions']={k:v for k,v in new.get('sessions',{}).items() if str(v.get('address','')).lower() not in targets}
            for field in ['pendingLogins','withdrawalFrozen']:
                if field in new:new[field]={k:v for k,v in new[field].items() if k.lower() not in targets}
            for field in ['deposits','withdrawals']:
                if field in new:new[field]=[v for v in new[field] if str(v.get('wallet','')).lower() not in targets]
        else:
            new['accounts']={k:v for k,v in new.get('accounts',{}).items() if k.lower() not in targets}
            for field in ['orders','fills','audit']:
                if field in new:new[field]=[v for v in new[field] if str(v.get('address','')).lower() not in targets]
        if old!=new:legacy_updates[name]=json.dumps(new,ensure_ascii=False,indent=2).encode()
    db.execute('BEGIN IMMEDIATE');db.execute('PRAGMA defer_foreign_keys=ON')
    for r in db.execute('SELECT address,payload_json FROM wallet_users WHERE lower(address) IN ('+slots+')',target_args).fetchall():
        p=json.loads(r['payload_json']);p['balances']={asset:'0' for asset in p.get('balances',{})}
        db.execute('UPDATE wallet_users SET balances_json=?,payload_json=? WHERE address=?',(json.dumps(p['balances']),json.dumps(p,ensure_ascii=False),r['address']))
    for t in ['lottery_accounts','airdrop_points_accounts']:
        db.execute('UPDATE '+q(t)+' SET points=0,payload_json=json_set(payload_json,\'$.points\',0) WHERE lower(wallet) IN ('+slots+')',target_args)
    zero_check=db.execute('SELECT balances_json,payload_json FROM wallet_users WHERE lower(address) IN ('+slots+')',target_args).fetchall()
    assert all(all(int(v)==0 for v in json.loads(r['balances_json']).values()) and all(int(v)==0 for v in json.loads(r['payload_json']).get('balances',{}).values()) for r in zero_check)
    blocked_row=db.execute("SELECT payload_json FROM service_settings WHERE setting_key='wallet_account_blocks'").fetchone()
    blocks=json.loads(blocked_row[0]) if blocked_row else {'wallets':{}}
    assert isinstance(blocks.get('wallets'),dict)
    now=datetime.datetime.now(datetime.timezone.utc).isoformat()
    for w in targets:blocks['wallets'][w]={'reason':'malicious social script submission or confirmed incident beneficiary','deletedAt':now,'incident':release}
    db.execute('INSERT INTO service_settings(setting_key,payload_json,updated_at) VALUES(?,?,?) ON CONFLICT(setting_key) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at',('wallet_account_blocks',json.dumps(blocks),int(time.time()*1000)))
    meta_row=db.execute("SELECT payload_json FROM service_settings WHERE setting_key='wallet_meta'").fetchone()
    if meta_row:
        meta=json.loads(meta_row[0]);meta['withdrawalFrozen']={k:v for k,v in meta.get('withdrawalFrozen',{}).items() if k.lower() not in targets}
        db.execute("UPDATE service_settings SET payload_json=?,updated_at=? WHERE setting_key='wallet_meta'",(json.dumps(meta),int(time.time()*1000)))
    deleted={}
    for t in [t for t in selectors if t!='wallet_users']+['wallet_users']:
        cond,args=selectors[t]
        deleted[t]=db.execute('DELETE FROM '+q(t)+' WHERE '+cond,args).rowcount
        assert deleted[t]==affected_before[t]
    assert not list(db.execute('PRAGMA foreign_key_check'))
    normal_after={t:digest_remaining(t,sel) for t,sel in selectors.items()}
    assert normal_after==normal_before,'Normal rows changed; transaction cancelled'
    for t in schema:
        if t!='service_settings':assert db.execute('SELECT COUNT(*) FROM '+q(t)).fetchone()[0]==table_before[t]-deleted.get(t,0)
    assert not any(re.search(pattern,r[0] or '',re.I) for r in db.execute('SELECT screenshot_url FROM social_submissions'))
    def replace_preserving(p,content):
        st=p.stat();tmp=p.with_name(p.name+'.next-'+release);tmp.write_bytes(content);os.chmod(tmp,st.st_mode);os.chown(tmp,st.st_uid,st.st_gid);os.replace(tmp,p)
    replace_preserving(file,body);code_switched=True
    for name,content in legacy_updates.items():replace_preserving(root/name,content)
    db.commit();committed=True
    assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    result={'cleanup_committed':True,'release':release,'backup':str(backup),'backup_database_sha256':db_backup_sha,'malicious_deleted':len(inventory),'malicious_statuses':dict(collections.Counter(x['status'] for x in inventory)),'accounts_deleted':deleted['wallet_users'],'accounts_with_balance_zeroed':sum(x['has_balance'] for x in accounts),'cleared_units':{k:str(v) for k,v in totals.items()},'lottery_points_cleared':points,'deleted_rows':{k:v for k,v in deleted.items() if v},'normal_rows_unchanged':normal_before==normal_after,'normal_accounts_retained':normal_after['wallet_users']['count'],'normal_social_submissions_retained':normal_after['social_submissions']['count'],'blocked_accounts':len(targets),'legacy_files_cleaned':list(legacy_updates),'deployed_sha256':plan['file']['after'],'started_at_utc':started}
    save_private('result.json',result);db.close();db=None
    run('systemctl','start','wg-platform',timeout=35)
    for attempt in range(15):
        try:
            with urllib.request.urlopen('http://127.0.0.1:8082/api/wallet/session',timeout=3) as response:health=json.load(response)
            if health.get('authenticated') is False:break
        except Exception:time.sleep(0.5)
    else:raise RuntimeError('Service did not become ready after cleanup')
    run('systemctl','is-active','--quiet','wg-platform')
    result['service']='active';result['completed_at_utc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    save_private('result.json',result)
    print(json.dumps(result,ensure_ascii=False,indent=2))
except Exception as error:
    if db:
        if not committed:db.rollback()
        db.close()
    if not committed and code_switched:
        shutil.copy2(backup/'src/wallet-service.js',file)
        for name in ['wallet-accounts.json','platform-accounts.json']:
            if (backup/name).exists():shutil.copy2(backup/name,root/name)
    if stop_attempted:
        subprocess.run(['systemctl','start','wg-platform'],capture_output=True,timeout=35)
    save_private('failure.json',{'cleanup_committed':committed,'error':str(error),'backup':str(backup)})
    raise
