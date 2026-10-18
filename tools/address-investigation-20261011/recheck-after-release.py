import sqlite3,json,datetime,hashlib,pathlib,subprocess
WALLETS=['0xd36ddfb9d3fa6b326b49e6eab68c5b961bc3ba59','0xf75a7c032b7a484269ced5663f7fa10acf63b1ac']
ZONE=datetime.timezone(datetime.timedelta(hours=8))
CUTOFF=int(datetime.datetime.fromisoformat('2026-10-11T02:45:39+08:00').timestamp()*1000)
def time(ms): return datetime.datetime.fromtimestamp(int(ms)/1000,ZONE).isoformat() if ms else None
def amount(units,asset):
    decimals={'USDT':6,'A':18,'BTC':8,'ETH':18,'BNB':18}.get(asset,18)
    value=int(units or 0);whole,part=divmod(abs(value),10**decimals)
    return ('-' if value<0 else '')+str(whole)+('.'+str(part).zfill(decimals).rstrip('0') if part else '')
out={'captured_at_beijing':datetime.datetime.now(ZONE).isoformat(),'release_cutoff_beijing':time(CUTOFF),'wallets':{},'file_hashes':{}}
db=sqlite3.connect('file:/opt/wg-platform/wg-platform.sqlite?mode=ro',uri=True);db.row_factory=sqlite3.Row
db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
meta=json.loads(db.execute("SELECT payload_json FROM service_settings WHERE setting_key='wallet_meta'").fetchone()[0])
out['withdrawal_automation']=meta.get('withdrawalAutomation')
for wallet in WALLETS:
    user=db.execute('SELECT balances_json,payload_json,created_at,updated_at FROM wallet_users WHERE address=? COLLATE NOCASE',(wallet,)).fetchone()
    p=json.loads(user['payload_json']) if user else {}
    entry={'balances':{a:amount(v,a) for a,v in p.get('balances',{}).items()},'indexed_balances':{a:amount(v,a) for a,v in json.loads(user['balances_json']).items()} if user else {},'updated_at':time(user['updated_at']) if user else None,'freeze':next((v for a,v in meta.get('withdrawalFrozen',{}).items() if a.lower()==wallet),None),'adjustments':[],'after_release':{},'latest_callbacks':[]}
    for r in db.execute('SELECT id,asset,amount_units,adjustment_type,created_at FROM balance_adjustments WHERE wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT 30',(wallet,)):
        entry['adjustments'].append({'id':r['id'],'asset':r['asset'],'amount':amount(r['amount_units'],r['asset']),'type':r['adjustment_type'],'time_beijing':time(r['created_at']),'after_release':r['created_at']>=CUTOFF})
    for table,cols,timestamp in [('balance_adjustments',['wallet'],'created_at'),('withdrawals',['wallet'],'created_at'),('a_token_claims',['wallet'],'created_at'),('a_token_withdrawals',['wallet'],'created_at'),('a_token_transfers',['from_wallet','to_wallet'],'created_at'),('a_token_trades',['wallet'],'created_at'),('orders',['address'],'created_at'),('fills',['address'],'created_at'),('audit_log',['address'],'created_at'),('a_token_miner_releases',['wallet'],'released_at'),('a_token_stake_rewards',['wallet'],'settled_at'),('social_submissions',['wallet'],'created_at'),('lottery_flows',['wallet'],'created_at')]:
        condition='('+ ' OR '.join(c+'=? COLLATE NOCASE' for c in cols)+') AND '+timestamp+'>=?'
        row=db.execute('SELECT COUNT(*) AS count,MIN('+timestamp+') AS first,MAX('+timestamp+') AS last FROM '+table+' WHERE '+condition,[wallet]*len(cols)+[CUTOFF]).fetchone()
        entry['after_release'][table]={'count':row['count'],'first':time(row['first']),'last':time(row['last'])}
    entry['withdrawals']=[{'id':r['id'],'amount':amount(r['amount_units'],r['asset']),'status_column':r['status'],'status_payload':json.loads(r['payload_json']).get('status'),'tx_hash':r['tx_hash'],'time_beijing':time(r['created_at'])} for r in db.execute('SELECT id,asset,amount_units,status,tx_hash,created_at,payload_json FROM withdrawals WHERE wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT 30',(wallet,))]
    for r in db.execute('SELECT note,created_at FROM lottery_flows WHERE wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT 10',(wallet,)):
        note=r['note'];label=note.split(' ',1)[0]
        item={'label':label[:30],'time_beijing':time(r['created_at']),'after_release':r['created_at']>=CUTOFF,'note_sha256':hashlib.sha256(note.encode()).hexdigest()}
        if 'CREDIT' in label or 'GRANT' in label:
            try:
                result=json.loads(note.split(' ',1)[1]);a=result.get('adjustment',{})
                item['result']={k:a[k] for k in ['id','wallet','asset','amount','createdAt'] if k in a};item['ok']=result.get('ok')
            except Exception:pass
        entry['latest_callbacks'].append(item)
    out['wallets'][wallet]=entry
db.rollback();db.close()
for name in ['src/lottery-service.js','src/a-token-api.js','src/withdrawal-payout-service.js','public/js/admin-lottery.js','public/js/admin-community.js','public/admin.html']:
    out['file_hashes'][name]=hashlib.sha256((pathlib.Path('/opt/wg-platform')/name).read_bytes()).hexdigest()
out['service']=subprocess.run(['systemctl','show','wg-platform','--property=MainPID,ActiveState,SubState,ActiveEnterTimestamp'],capture_output=True,text=True,timeout=5).stdout
print(json.dumps(out,ensure_ascii=False,indent=2))
