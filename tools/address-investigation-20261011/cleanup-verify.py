import sqlite3,json,re,datetime,pathlib,subprocess,urllib.request,urllib.error,http.cookiejar,hashlib
root=pathlib.Path('/opt/wg-platform')
backup=root/'backups/incident-cleanup-20261011-030921'
evidence=json.loads((backup/'evidence-summary.json').read_text());targets=set(evidence['targets'])
result=json.loads((backup/'result.json').read_text())
pattern=r'<script\b|\bon[a-z]+\s*=|javascript\s*:|<iframe\b|<object\b|<embed\b'
base='http://127.0.0.1:8082';env={}
for line in (root/'.env').read_text().splitlines():
    line=line.strip()
    if line and not line.startswith('#') and '=' in line:
        k,v=line.split('=',1);env[k.strip()]=v.strip().strip('"').strip("'")
jar=http.cookiejar.CookieJar();opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(path,body=None,public=False):
    origin='https://axix.cc' if public else base
    req=urllib.request.Request(origin+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json','Origin':origin,'User-Agent':'WG-Incident-Verification/1.0'})
    try:
        with opener.open(req,timeout=20) as res:return res.status,json.load(res)
    except urllib.error.HTTPError as err:
        return err.code,json.load(err)
out={'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'service':subprocess.run(['systemctl','show','wg-platform','--property=ActiveState,SubState,MainPID'],capture_output=True,text=True,check=True).stdout}
logged=False
try:
    code,response=call('/api/admin/login',{'username':env['PLATFORM_ADMIN_USERNAME'],'password':env['PLATFORM_ADMIN_PASSWORD']});assert code==200;logged=True
    code,users=call('/api/admin/users');assert code==200
    listed={x['address'].lower() for x in users['users']};assert not listed&targets
    out['admin_users']={'count':len(listed),'deleted_accounts_found':0}
    code,social=call('/api/admin/lottery/social');assert code==200
    assert not any(re.search(pattern,x.get('screenshotUrl',''),re.I) for x in social['list'])
    assert not {x['wallet'].lower() for x in social['list']}&targets
    out['admin_social']={'normal_count':len(social['list']),'malicious_found':0}
    probes=['0xd36ddfb9d3fa6b326b49e6eab68c5b961bc3ba59','0xf75a7c032b7a484269ced5663f7fa10acf63b1ac']
    out['blocked_login_checks']=[]
    for wallet in probes:
        code,data=call('/api/wallet/login-challenge',{'address':wallet});assert code==400 and '账户已被封禁' in data.get('error','')
        code2,data2=call('/api/wallet/login-challenge',{'address':wallet},public=True);assert code2==400 and '账户已被封禁' in data2.get('error','')
        out['blocked_login_checks'].append({'wallet':wallet,'local_blocked':True,'public_blocked':True})
    normal=next(iter(listed));code,data=call('/api/wallet/login-challenge',{'address':normal});assert code==200 and isinstance(data.get('message'),str)
    out['normal_login_challenge_passed']=True
finally:
    if logged:call('/api/admin/logout',{})
db=sqlite3.connect('file:'+str(root/'wg-platform.sqlite')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
slots=','.join('?' for _ in targets);args=sorted(targets)
out['remaining_deleted_accounts']=db.execute('SELECT COUNT(*) FROM wallet_users WHERE lower(address) IN ('+slots+')',args).fetchone()[0];assert out['remaining_deleted_accounts']==0
out['remaining_deleted_sessions']=db.execute('SELECT COUNT(*) FROM wallet_sessions WHERE lower(address) IN ('+slots+')',args).fetchone()[0];assert out['remaining_deleted_sessions']==0
out['malicious_database_count']=sum(bool(re.search(pattern,r[0] or '',re.I)) for r in db.execute('SELECT screenshot_url FROM social_submissions'));assert out['malicious_database_count']==0
blocks=json.loads(db.execute("SELECT payload_json FROM service_settings WHERE setting_key='wallet_account_blocks'").fetchone()[0]);assert targets<=set(blocks['wallets'])
out['persisted_blocks']=len(targets)
out['foreign_key_errors']=len(list(db.execute('PRAGMA foreign_key_check')));assert out['foreign_key_errors']==0
out['integrity']=db.execute('PRAGMA integrity_check').fetchone()[0];assert out['integrity']=='ok'
out['source_hash']=hashlib.sha256((root/'src/wallet-service.js').read_bytes()).hexdigest();assert out['source_hash']==result['deployed_sha256']
out['automatic_usdt_withdrawals_enabled']=json.loads(db.execute("SELECT payload_json FROM service_settings WHERE setting_key='wallet_meta'").fetchone()[0]).get('withdrawalAutomation',{}).get('enabled')
db.rollback();db.close()
print(json.dumps(out,ensure_ascii=False,indent=2))
