import sqlite3,json,datetime,pathlib,urllib.request,urllib.error,http.cookiejar,subprocess,hashlib,collections
from decimal import Decimal
root=pathlib.Path('/opt/wg-platform');base='http://127.0.0.1:8082';env={}
for line in (root/'.env').read_text().splitlines():
    line=line.strip()
    if line and not line.startswith('#') and '=' in line:
        k,v=line.split('=',1);env[k.strip()]=v.strip().strip('"').strip("'")
jar=http.cookiejar.CookieJar();opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(path,body=None):
    req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json','Origin':base})
    with opener.open(req,timeout=20) as response:return json.load(response)
db=sqlite3.connect('file:'+str(root/'wg-platform.sqlite')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
wallets=['0x968acf8d6111b7668d730641d86efaec0f6b48a6','0xc6da1e64eca3cb29e160fd72a1787a6e9e40a11d','0x436252b4759eee30066a0d1101911caa7a63ccf2']
out={'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'admin_details':[]}
logged=False
try:
    assert call('/api/admin/login',{'username':env['PLATFORM_ADMIN_USERNAME'],'password':env['PLATFORM_ADMIN_PASSWORD']}).get('authenticated',True);logged=True
    out['pool_stats']=call('/api/admin/a-token/stats')['pool']
    for wallet in wallets:
        detail=call('/api/admin/users/'+wallet+'/detail')
        if 'detail' in detail:detail=detail['detail']
        team_rows=db.execute('SELECT amount_units FROM a_token_team_rewards WHERE recipient_wallet=? COLLATE NOCASE',(wallet,)).fetchall()
        stake_rows=db.execute('SELECT amount_units,payload_json FROM a_token_stake_rewards WHERE wallet=? COLLATE NOCASE ORDER BY settled_at,id',(wallet,)).fetchall()
        balance=json.loads(db.execute('SELECT payload_json FROM wallet_users WHERE address=? COLLATE NOCASE',(wallet,)).fetchone()[0])['balances']['A']
        out['admin_details'].append({'wallet':wallet,'AIX_balance_api':detail.get('aixBalance'),'AIX_balance_units':balance,'team_api':detail.get('teamRewards'),'team_actual_count':len(team_rows),'team_actual_units':str(sum(int(r[0]) for r in team_rows)),'stake_api':{k:v for k,v in detail.get('stakes',{}).items() if k!='items'},'stake_credited_units':str(sum(int(r['amount_units']) for r in stake_rows)),'stake_recorded_interest_units':str(sum(int(json.loads(r['payload_json']).get('interestUnits',0)) for r in stake_rows)),'stake_records_with_explicit_split':sum('interestUnits' in json.loads(r['payload_json']) for r in stake_rows),'stake_records':len(stake_rows)})
finally:
    if logged:call('/api/admin/logout',{})
db.rollback();db.close()
# Summarize settlement errors without exporting raw logs, cookies or signatures.
start=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).replace(hour=0,minute=0,second=0,microsecond=0)
logs=subprocess.run(['journalctl','-u','wg-platform','--since','@'+str(int(start.timestamp())),'--no-pager','-o','json'],capture_output=True,text=True,timeout=20,check=True)
counts=collections.Counter();samples=[]
for line in logs.stdout.splitlines():
    try:row=json.loads(line);message=row.get('MESSAGE','')
    except Exception:continue
    categories=['[A币矿机]','[A币质押]','[平级奖日结]','[平级奖日结] 启动补发失败','[A10池日结]','[抽奖]']
    for c in categories:
        if c in message and any(x in message.lower() for x in ['失败','error','invalid','exception','constraint','not found','range']):
            counts[c]+=1
            if len(samples)<8:samples.append({'category':c,'timestamp':row.get('__REALTIME_TIMESTAMP'),'sha256':hashlib.sha256(message.encode()).hexdigest()})
out['settlement_error_log_counts']=dict(counts);out['settlement_error_log_hash_samples']=samples
out['service']=subprocess.run(['systemctl','show','wg-platform','--property=ActiveState,SubState'],capture_output=True,text=True,check=True).stdout
print(json.dumps(out,ensure_ascii=False,indent=2))
