import hashlib,sqlite3,json,urllib.request,datetime,subprocess
W='0xd36ddfb9d3fa6b326b49e6eab68c5b961bc3ba59';R='0xf75a7c032b7a484269ced5663f7fa10acf63b1ac'
out={'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'http':{},'wallets':{},'latest_callbacks':[]}
for uri in ['/api/wallet/session','/api/admin/session','/admin.html','/js/admin-lottery.js?v=4-security-20261011','/js/admin-community.js?v=7-security-20261011']:
    with urllib.request.urlopen('http://127.0.0.1:8082'+uri,timeout=8) as res:
        body=res.read();p={'status':res.status,'sha256':hashlib.sha256(body).hexdigest(),'cache_control':res.headers.get('Cache-Control')}
        if uri.endswith('/session'):p['data']=json.loads(body)
        if uri=='/admin.html':p['new_script_versions']='v=4-security-20261011' in body.decode() and 'v=7-security-20261011' in body.decode()
        out['http'][uri]=p
db=sqlite3.connect('file:/opt/wg-platform/wg-platform.sqlite?mode=ro',uri=True);db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
meta=json.loads(db.execute("SELECT payload_json FROM service_settings WHERE setting_key='wallet_meta'").fetchone()[0])
out['automation']=meta.get('withdrawalAutomation');out['freeze_records']={a:v for a,v in meta.get('withdrawalFrozen',{}).items() if a.lower() in [W,R]}
pool=json.loads(db.execute("SELECT payload_json FROM service_settings WHERE setting_key='a_token_pool_meta'").fetchone()[0]);out['aix_withdraw_enabled']=pool.get('withdrawEnabled')
for wallet in [W,R]:
    row=db.execute('SELECT balances_json,payload_json FROM wallet_users WHERE address=? COLLATE NOCASE',(wallet,)).fetchone()
    out['wallets'][wallet]={'balances_column':json.loads(row[0]),'balances_payload':json.loads(row[1]).get('balances'),'frozen':wallet in {a.lower() for a in out['freeze_records']}}
    out['wallets'][wallet]['withdrawals']=[{'status':r['status'],'amount_units':r['amount_units'],'created_at':r['created_at'],'has_tx_hash':bool(r['tx_hash']),'payload_status':json.loads(r['payload_json']).get('status')} for r in db.execute('SELECT status,amount_units,created_at,tx_hash,payload_json FROM withdrawals WHERE wallet=? COLLATE NOCASE',(wallet,))]
for r in db.execute('SELECT note,created_at FROM lottery_flows WHERE wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT 14',(W,)):
    note=r['note'];label=note.split(' ',1)[0];p={'time_ms':r['created_at'],'label':label,'reports_ok':'"ok":true' in note.replace(' ',''),'note_sha256':hashlib.sha256(note.encode()).hexdigest()}
    if 'GRANT' in label or 'CREDIT' in label:
        try:
            v=json.loads(note.split(' ',1)[1]);a=v.get('adjustment',{});p['result']={k:a[k] for k in ['id','wallet','asset','amount','createdAt'] if k in a}
        except Exception:pass
    out['latest_callbacks'].append(p)
out['latest_adjustments']=[dict(r) for r in db.execute('SELECT id,wallet,asset,amount_units,adjustment_type,created_at FROM balance_adjustments WHERE wallet=? COLLATE NOCASE OR wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT 12',(W,R))]
db.rollback();db.close()
out['service']=subprocess.run(['systemctl','show','wg-platform','--property=MainPID,ActiveState,SubState,ActiveEnterTimestamp'],capture_output=True,text=True).stdout
print(json.dumps(out,ensure_ascii=False,indent=2))
