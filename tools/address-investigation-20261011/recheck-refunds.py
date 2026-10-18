import sqlite3,json,datetime,os,re
R='0xf75a7c032b7a484269ced5663f7fa10acf63b1ac';ZONE=datetime.timezone(datetime.timedelta(hours=8))
db=sqlite3.connect('file:/opt/wg-platform/wg-platform.sqlite?mode=ro',uri=True);db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
out={'captured_at_beijing':datetime.datetime.now(ZONE).isoformat(),'withdrawals':[],'admin_request_log':[],'server_log':[]};ids=[]
for r in db.execute('SELECT id,amount_units,status,created_at,processed_at,payload_json FROM withdrawals WHERE wallet=? COLLATE NOCASE ORDER BY created_at DESC',(R,)):
    p=json.loads(r['payload_json']);item={k:r[k] for k in ['id','amount_units','status','created_at','processed_at']}
    item['payload']={k:p[k] for k in ['id','amountUnits','status','createdAt','processedAt','reason','rejectReason','releasedAt','heldAt'] if k in p}
    out['withdrawals'].append(item);ids.append(r['id'])
db.rollback();db.close()
file='/var/log/nginx/access.log';size=os.path.getsize(file)
pattern=re.compile(r'^(\S+) .*?\[([^\]]+)\] "(\S+) (.*?) HTTP/[^" ]+" (\d+)')
with open(file,errors='replace') as f:
    offset=max(0,size-32*1024*1024);f.seek(offset)
    if offset:f.readline()
    for line in f:
        if '/api/admin/withdrawals/' not in line or not any(id in line for id in ids):continue
        m=pattern.match(line)
        if not m:continue
        ip,t,method,url,status=m.groups()
        if method!='POST':continue
        out['admin_request_log'].append({'proxy_ip':ip,'time':t,'method':method,'path':url.split('?',1)[0],'status':int(status)})
out['admin_request_log']=out['admin_request_log'][-20:]
for file in ['/opt/wg-platform/logs/server.stdout.log','/opt/wg-platform/logs/server.stderr.log']:
    with open(file,errors='replace') as f:
        for line in f:
            if any(id in line for id in ids) and not re.search(r'cookie|signature|token|password|rawTransaction',line,re.I):out['server_log'].append(line.strip()[:250])
out['server_log']=out['server_log'][-15:]
print(json.dumps(out,ensure_ascii=False,indent=2))
