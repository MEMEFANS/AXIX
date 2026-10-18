import sqlite3,json,re,datetime,hashlib,base64,gzip,pathlib,collections
root=pathlib.Path('/opt/wg-platform')
db=sqlite3.connect('file:'+str(root/'wg-platform.sqlite')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
known={'0xd36ddfb9d3fa6b326b49e6eab68c5b961bc3ba59','0xf75a7c032b7a484269ced5663f7fa10acf63b1ac'}
pattern=r'<script\b|\bon[a-z]+\s*=|javascript\s*:|<iframe\b|<object\b|<embed\b'
inventory=[]
for r in db.execute('SELECT id,wallet,status,screenshot_url FROM social_submissions'):
    s=r['screenshot_url'] or ''
    if re.search(pattern,s,re.I):
        inventory.append({'id':r['id'],'wallet':r['wallet'].lower(),'status':r['status'],'sha256':hashlib.sha256(s.encode()).hexdigest(),'indicators':sorted(set(x.lower() for x in re.findall(r'<(?:script|iframe|object|embed)\b|\bon[a-z]+\s*=|javascript\s*:',s,re.I)))})
targets=sorted(known|{x['wallet'] for x in inventory})
tables={}
wallet_cols={'wallet','address','from_wallet','to_wallet','recipient_wallet','source_wallet','referrer_wallet','wallet_address','owner_wallet'}
for t in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
    name=t[0]; cols=[dict(x) for x in db.execute('PRAGMA table_info("'+name+'")')]
    fks=[dict(x) for x in db.execute('PRAGMA foreign_key_list("'+name+'")')]
    relevant=[c['name'] for c in cols if c['name'] in wallet_cols]
    where=' OR '.join('lower("'+c+'") IN ('+','.join('?' for _ in targets)+')' for c in relevant)
    matched=db.execute('SELECT COUNT(*) FROM "'+name+'" WHERE '+where,targets*len(relevant)).fetchone()[0] if where else 0
    tables[name]={'columns':[c['name'] for c in cols],'foreign_keys':fks,'wallet_columns':relevant,'matched':matched,'total':db.execute('SELECT COUNT(*) FROM "'+name+'"').fetchone()[0]}
balances=[]
for w in targets:
    row=db.execute('SELECT address,balances_json,payload_json FROM wallet_users WHERE lower(address)=?',(w,)).fetchone()
    if row:
        p=json.loads(row['payload_json']); balances.append({'wallet':w,'balances':p.get('balances',{}),'balances_column':json.loads(row['balances_json'])})
meta={}
for row in db.execute('SELECT setting_key,payload_json FROM service_settings'):
    p=json.loads(row['payload_json'])
    meta[row['setting_key']]={'keys':list(p) if isinstance(p,dict) else [],'target_occurrences':sum(row['payload_json'].lower().count(w) for w in targets)}
files={}
for name in ['src/wallet-service.js','src/database.js','src/platform-service.js','src/wallet-api.js','src/atomic-ledger.js']:
    p=root/name
    if p.exists(): files[name]={'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'gzip_base64':base64.b64encode(gzip.compress(p.read_bytes())).decode()}
print(json.dumps({'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'malicious':inventory,'statuses':dict(collections.Counter(x['status'] for x in inventory)),'targets':targets,'balances':balances,'tables':tables,'meta':meta,'files':files},ensure_ascii=False))
db.rollback();db.close()
