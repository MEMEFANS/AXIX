import collections, datetime, hashlib, json, pathlib, re, sqlite3
ZONE=datetime.timezone(datetime.timedelta(hours=8));NOW=datetime.datetime.now(ZONE);SINCE=NOW.timestamp()-3600
db=sqlite3.connect('file:/opt/wg-platform/wg-platform.sqlite?mode=ro',uri=True,timeout=5);db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
out={'captured_beijing':NOW.isoformat(),'readonly':True}
out['support_indicators']=[]
for r in db.execute("SELECT m.id,m.body,m.created_at,t.wallet FROM support_messages m JOIN support_tickets t ON t.id=m.ticket_id WHERE m.id IN ('be7b0f1f-8683-4ddf-bee9-941dab60b165','7112e290-529c-4958-94fd-9c33b9f88676','dbd289d1-8c0b-49a6-a2c3-ea4c5dcba4ec')"):
    text=r['body'] or ''
    out['support_indicators'].append({'id':r['id'],'wallet':r['wallet'],'length':len(text),'financial_api_reference':bool(re.search(r'/api/(?:admin|wallet/admin)',text,re.I)),'network_or_storage_access':bool(re.search(r'fetch\s*\(|XMLHttpRequest|document\.cookie|localStorage|sessionStorage',text,re.I)),'simple_alert_or_probe':bool(re.search(r'alert\s*\(',text,re.I)),'script_sha256':hashlib.sha256(text.encode()).hexdigest()})
out['latest_adjustments']=[dict(r) for r in db.execute('SELECT wallet,asset,amount_units,adjustment_type,reason,created_at FROM balance_adjustments ORDER BY created_at DESC LIMIT 5')]
out['new_withdrawals_last_hour']=[dict(r) for r in db.execute('SELECT wallet,asset,amount_units,status,created_at,processed_at,tx_hash FROM withdrawals WHERE created_at>=? OR processed_at>=? ORDER BY created_at DESC',(int(SINCE*1000),int(SINCE*1000)))]
meta=json.loads(db.execute("SELECT payload_json FROM service_settings WHERE setting_key='wallet_meta'").fetchone()[0]);out['frozen_wallets']=list(meta.get('withdrawalFrozen',{}));out['automation']=meta.get('withdrawalAutomation')
db.rollback();db.close()
pattern=re.compile(r'^(\S+) .*?\[([^\]]+)\] "(\S+) (.*?) HTTP/[^" ]+" (\d+)')
groups=collections.Counter();known={};status=collections.Counter();mins=collections.Counter();start=None;end=None;datecache={};total=0
path=pathlib.Path('/var/log/nginx/access.log');size=path.stat().st_size
with path.open('rb') as f:
    offset=max(0,size-32*1024*1024);f.seek(offset)
    if offset:f.readline()
    for line in f:
        s=line.decode(errors='replace');m=pattern.match(s)
        if not m:continue
        ip,t,method,uri,code=m.groups()
        if t not in datecache:datecache[t]=datetime.datetime.strptime(t,'%d/%b/%Y:%H:%M:%S %z').timestamp()
        ts=datecache[t];start=min(start,ts) if start is not None else ts;end=max(end,ts) if end is not None else ts
        if ts<SINCE or 'WG-Owner-Security-Readonly-20261014' in s:continue
        total+=1;status[code]+=1
        mins[datetime.datetime.fromtimestamp(ts,ZONE).strftime('%H:%M')]+=1
        request_path=uri.split('?',1)[0][:220]
        if ip in ['89.117.2.130','2a03:90c0:2c7:1::11a']:
            groups[(ip,method,request_path,code)]+=1;known[ip]=t
out['recent_web']={'window_start':datetime.datetime.fromtimestamp(SINCE,ZONE).isoformat(),'total':total,'statuses':dict(status),'max_requests_per_minute':max(mins.values()) if mins else 0,'known_scan_sources':[{'ip':k[0],'method':k[1],'path':k[2],'status':int(k[3]),'count':v} for k,v in groups.items()],'known_source_latest':known,'covered_full_hour':start is not None and start<=SINCE,'scanned_from':datetime.datetime.fromtimestamp(start,ZONE).isoformat() if start else None,'scanned_to':datetime.datetime.fromtimestamp(end,ZONE).isoformat() if end else None}
print(json.dumps(out,ensure_ascii=False,separators=(',',':')))
