import sqlite3,json,re,datetime,hashlib,os,glob
W='0xd36ddfb9d3fa6b326b49e6eab68c5b961bc3ba59'; RELATED='0xf75a7c032b7a484269ced5663f7fa10acf63b1ac'
db=sqlite3.connect('file:/opt/wg-platform/wg-platform.sqlite?mode=ro',uri=True);db.row_factory=sqlite3.Row
db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
out={'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'wallet_states':[]}
for address in [W,RELATED]:
    r=db.execute('SELECT address,balances_json,payload_json,created_at,updated_at FROM wallet_users WHERE address=? COLLATE NOCASE',(address,)).fetchone()
    if not r: continue
    data=json.loads(r['payload_json']);out['wallet_states'].append({'address':r['address'],'balances_column':json.loads(r['balances_json']),'balances_payload':data.get('balances'),'created_at':r['created_at'],'updated_at':r['updated_at']})
    out['wallet_states'][-1]['outgoing_record_counts']={table:db.execute('SELECT COUNT(*) FROM '+table+' WHERE '+col+'=? COLLATE NOCASE',(address,)).fetchone()[0] for table,col in [('withdrawals','wallet'),('a_token_withdrawals','wallet'),('a_token_claims','wallet'),('a_token_transfers','from_wallet')]}
meta=db.execute("SELECT payload_json,updated_at FROM service_settings WHERE setting_key='wallet_meta'").fetchone()
if meta:
    p=json.loads(meta['payload_json']);out['wallet_meta']={'updated_at':meta['updated_at'],'withdrawalAutomation':p.get('withdrawalAutomation'),'target_frozen':{a:v for a,v in p.get('withdrawalFrozen',{}).items() if a.lower() in [W,RELATED]}}
out['setting_keys']=[r[0] for r in db.execute('SELECT setting_key FROM service_settings')]
out['malicious_submission_inventory']=[]
for r in db.execute('SELECT id,wallet,platform,screenshot_url,status,created_at FROM social_submissions'):
    s=r['screenshot_url']
    if re.search(r'<\w|onerror\s*=|javascript:|<script',s,re.I):
        out['malicious_submission_inventory'].append({'id':r['id'],'wallet':r['wallet'],'platform':r['platform'],'status':r['status'],'created_at':r['created_at'],'sha256':hashlib.sha256(s.encode()).hexdigest(),'associated_with_target':W in s.lower(),'contains_target': W in s.lower(),'related_wallet':RELATED in s.lower()})
out['target_social_engineering_messages']=[]
for r in db.execute('SELECT m.id,m.sender,m.created_at,m.body FROM support_messages m JOIN support_tickets t ON t.id=m.ticket_id WHERE t.wallet=? COLLATE NOCASE ORDER BY m.created_at',(W,)):
    if '<' not in r['body'] and not re.search(r'password|cookie|token|signature|私钥|密码',r['body'],re.I):
        out['target_social_engineering_messages'].append({'id':r['id'],'sender':r['sender'],'created_at':r['created_at'],'text':r['body'][:180]})
out['config_files']=[]
for p in glob.glob('/opt/wg-platform/*.json'):
    if any(x in os.path.basename(p) for x in ['community','a-token','withdraw']):
        data=json.load(open(p))
        def clean(x):
            if isinstance(x,dict): return {k:clean(v) for k,v in x.items() if not re.search(r'private|password|secret|token|signature|signer',k,re.I)}
            if isinstance(x,list): return [clean(v) for v in x]
            if isinstance(x,str) and (len(x)>400 or '<' in x): return {'length':len(x),'contains_markup':'<' in x,'sha256':hashlib.sha256(x.encode()).hexdigest()}
            return x
        out['config_files'].append({'file':p,'mtime':os.stat(p).st_mtime,'data':clean(data)})
out['incident_backup_directories']=[{'path':p,'mtime':os.stat(p).st_mtime} for p in glob.glob('/opt/wg-platform/backups/*') if os.stat(p).st_mtime>1791648000][-25:]
db.rollback();db.close()
print(json.dumps(out,ensure_ascii=False,indent=2))
