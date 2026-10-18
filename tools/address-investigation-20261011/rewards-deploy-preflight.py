import pathlib,hashlib,json,base64,gzip,sqlite3,datetime,subprocess,urllib.request
root=pathlib.Path('/opt/wg-platform')
names=['src/platform-service.js','src/server.js','src/a-token-income.js','src/a-token-revenue-service.js','src/a-token-admin-income.js','public/js/operator-admin.js','public/admin.html']
protected=['src/wallet-service.js','src/database.js','src/a-token-team-service.js','src/lottery-service.js','src/a-token-api.js','src/withdrawal-payout-service.js','public/js/admin-lottery.js','public/js/admin-community.js']
out={'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':{},'protected':{}}
for name in names+protected:
    p=root/name
    v={'exists':p.exists()}
    if p.exists():
        data=p.read_bytes();v['sha256']=hashlib.sha256(data).hexdigest()
        if name in names:v['gzip_base64']=base64.b64encode(gzip.compress(data)).decode()
    out['files' if name in names else 'protected'][name]=v
db=sqlite3.connect('file:'+str(root/'wg-platform.sqlite')+'?mode=ro',uri=True);db.execute('PRAGMA query_only=ON')
out['users']=db.execute('SELECT COUNT(*) FROM wallet_users').fetchone()[0]
out['reward_counts']={t:db.execute('SELECT COUNT(*) FROM '+t).fetchone()[0] for t in ['a_token_miner_releases','a_token_stake_rewards','a_token_team_rewards']}
out['wallet_meta_withdrawal_auto_enabled']=json.loads(db.execute("SELECT payload_json FROM service_settings WHERE setting_key='wallet_meta'").fetchone()[0]).get('withdrawalAutomation',{}).get('enabled')
out['deleted_attack_accounts_present']=db.execute('SELECT COUNT(*) FROM wallet_users WHERE address IN (?,?) COLLATE NOCASE',('0xd36ddfb9d3fa6b326b49e6eab68c5b961bc3ba59','0xf75a7c032b7a484269ced5663f7fa10acf63b1ac')).fetchone()[0]
db.close()
out['service']=subprocess.run(['systemctl','show','wg-platform','--property=MainPID,ActiveState,SubState'],capture_output=True,text=True,check=True,timeout=10).stdout
for uri in ['/api/wallet/session','/api/admin/session']:
    with urllib.request.urlopen('http://127.0.0.1:8082'+uri,timeout=10) as r:out[uri]={'status':r.status,'authenticated':json.load(r).get('authenticated')}
print(json.dumps(out,ensure_ascii=False))
