import collections, datetime, glob, hashlib, json, os, pathlib, re, sqlite3, subprocess

ROOT = pathlib.Path('/opt/wg-platform')
ZONE = datetime.timezone(datetime.timedelta(hours=8))
NOW = datetime.datetime.now(ZONE)
CUTOFF = int(datetime.datetime.fromisoformat('2026-10-11T03:09:21+08:00').timestamp()*1000)
def run(args):
    p = subprocess.run(args,capture_output=True,text=True,timeout=15)
    return {'code':p.returncode,'output':p.stdout[:20000]}
def time(ms):
    return datetime.datetime.fromtimestamp(int(ms)/1000,ZONE).isoformat() if ms else None
def scrub(value):
    if isinstance(value,dict):
        return {k:scrub(v) for k,v in value.items() if not re.search(r'password|secret|signature|token_hash|cookie|authorization|private|session',k,re.I)}
    if isinstance(value,list): return [scrub(v) for v in value]
    if isinstance(value,str): return value[:1000]
    return value
out = {'captured_beijing':NOW.isoformat(),'readonly':True,'since_cleanup':time(CUTOFF)}
out['health'] = {
 'service':run(['systemctl','show','wg-platform','--property=ActiveState,SubState,MainPID,ActiveEnterTimestamp,NRestarts,MemoryCurrent,CPUUsageNSec']),
 'uptime':run(['uptime']),
 'memory':run(['free','-m']),
 'disk':run(['df','-h','/opt/wg-platform']),
 'listeners':run(['ss','-lntp']),
 'processes':run(['ps','-eo','pid,ppid,comm,%cpu,%mem,etimes','--sort=-%cpu']),
}
out['log_files'] = [{'path':p,'bytes':os.path.getsize(p),'mtime':datetime.datetime.fromtimestamp(os.path.getmtime(p),ZONE).isoformat()} for pat in ['/var/log/nginx/*log*','/opt/wg-platform/logs/*','/var/log/auth.log*'] for p in glob.glob(pat) if os.path.isfile(p)]
out['nginx_configuration'] = []
for path in ['/etc/nginx/nginx.conf']+glob.glob('/etc/nginx/sites-enabled/*')+glob.glob('/etc/nginx/conf.d/*'):
    if not os.path.isfile(path): continue
    selected=[{'line':i+1,'text':line.strip()} for i,line in enumerate(open(path)) if re.search(r'log_format|access_log|error_log|real_ip|proxy_set_header|limit_req|limit_conn|listen|server_name|location|deny|allow',line)]
    out['nginx_configuration'].append({'path':path,'lines':selected})
out['security_files'] = {}
for name in ['src/admin-security.js','src/funds-admin-api.js','src/server.js','src/lottery-service.js','src/a-token-admin-api.js','src/wallet-service.js','src/support-service.js','public/js/admin-lottery.js','public/js/operator-admin.js','public/js/support-chat.js','public/js/admin-dialogs.js','public/admin.html','public/funds-admin.html']:
    data=(ROOT/name).read_bytes()
    out['security_files'][name] = {'sha256':hashlib.sha256(data).hexdigest()}
db=sqlite3.connect('file:'+str(ROOT/'wg-platform.sqlite')+'?mode=ro',uri=True,timeout=5)
db.row_factory=sqlite3.Row
db.execute('PRAGMA query_only=ON')
db.execute('BEGIN')
tables=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
out['schema']={}
for name in tables:
    if any(x in name for x in ['adjust','audit','social','support','withdraw','deposit','miner','grant','agent','setting']):
        out['schema'][name] = {'columns':[r[1] for r in db.execute('PRAGMA table_info("'+name+'")')],'count':db.execute('SELECT COUNT(*) FROM "'+name+'"').fetchone()[0]}
out['users_count']=db.execute('SELECT COUNT(*) FROM wallet_users').fetchone()[0]
out['balance_adjustments_since_cleanup']=[scrub(dict(r)) for r in db.execute('SELECT * FROM balance_adjustments WHERE created_at>=? ORDER BY created_at DESC',(CUTOFF,))]
out['audit_types_since_cleanup']=[dict(r) for r in db.execute('SELECT event_type,COUNT(*) AS count,MAX(created_at) AS latest FROM audit_log WHERE created_at>=? GROUP BY event_type ORDER BY count DESC',(CUTOFF,))]
out['service_settings']={}
for r in db.execute('SELECT setting_key,payload_json FROM service_settings'):
    key=r['setting_key']
    if key=='wallet_meta':
        meta=json.loads(r['payload_json'])
        out['service_settings'][key]={'keys':list(meta),'withdrawalAutomation':scrub(meta.get('withdrawalAutomation')),'withdrawalFrozen':scrub(meta.get('withdrawalFrozen')),'blocked':{k:scrub(v) for k,v in meta.items() if 'ban' in k.lower() or 'block' in k.lower()}}
    elif any(x in key.lower() for x in ['withdraw','community','security','ban','block']):
        out['service_settings'][key]=scrub(json.loads(r['payload_json']))
known=['0xd36ddfb9d3fa6b326b49e6eab68c5b961bc3ba59','0xf75a7c032b7a484269ced5663f7fa10acf63b1ac']
out['known_wallets']={}
for wallet in known:
    entry={}
    for table in ['wallet_users','balance_adjustments','social_submissions','withdrawals','a_token_withdrawals']:
        if table not in tables:continue
        cols=[r[1] for r in db.execute('PRAGMA table_info("'+table+'")')]
        col='address' if table=='wallet_users' else 'wallet'
        if col in cols:
            entry[table]=db.execute('SELECT COUNT(*) FROM "'+table+'" WHERE "'+col+'"=? COLLATE NOCASE',(wallet,)).fetchone()[0]
    out['known_wallets'][wallet]=entry
db.rollback()
db.close()
print(json.dumps(out,ensure_ascii=False,separators=(',',':')))
