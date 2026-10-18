import sqlite3,json,datetime,pathlib,hashlib,base64,gzip,collections,os
root=pathlib.Path('/opt/wg-platform');now=datetime.datetime.now(datetime.timezone.utc)
bj=datetime.timezone(datetime.timedelta(hours=8));start=datetime.datetime.combine(now.astimezone(bj).date(),datetime.time.min,bj);startms=int(start.timestamp()*1000)
db=sqlite3.connect('file:'+str(root/'wg-platform.sqlite')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
out={'captured_at_utc':now.isoformat(),'day_start_beijing':start.isoformat(),'day_start_ms':startms,'users':[],'tables':{},'schema':{},'settings':{},'sources':{},'backup_inventory':[]}
for r in db.execute('SELECT address,balances_json,created_at,updated_at,payload_json FROM wallet_users'):
    p=json.loads(r['payload_json']);out['users'].append({'wallet':r['address'].lower(),'balances':p.get('balances',{}),'balances_column':json.loads(r['balances_json']),'created_at':r['created_at'],'updated_at':r['updated_at']})
all_tables=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
for t in all_tables:out['schema'][t]=[r['name'] for r in db.execute('PRAGMA table_info("'+t+'")')]
full_tables=['a_token_miners','a_token_miner_releases','a_token_stakes','a_token_stake_rewards','a_token_team_rewards','a_token_direct_count_rewards','a_token_transfers','a_token_trades','a_token_orders','a_token_activations','a_token_a10_pool','a_token_burns','a_token_team_levels','a_token_team_stats_overrides','platform_referral_links','ai_managed_batches','ai_managed_rewards','referral_rewards','deposits','withdrawals','balance_adjustments','lottery_accounts','lottery_wins','airdrop_points_accounts','airdrop_points_flows','orders','fills','a_token_withdrawals']
for t in full_tables:
    if t not in all_tables:continue
    rows=[]
    for r in db.execute('SELECT * FROM "'+t+'"'):
        row=dict(r)
        if 'payload_json' in row:
            p=json.loads(row.pop('payload_json') or '{}')
            # Never export signatures, passwords, cookies or signed transactions.
            for k in list(p):
                if any(s in k.lower() for s in ['signature','password','secret','private','tokenhash','rawtransaction']):p.pop(k)
            if t=='lottery_wins':p.pop('addressPayload',None);p.pop('address',None)
            row['payload']=p
        if t=='lottery_wins':row.pop('address_payload',None)
        if t=='withdrawals':row['payload'].pop('rawTransaction',None)
        rows.append(row)
    out['tables'][t]=rows
out['platform_accounts']=[{'wallet':r['address'].lower(),'payload':json.loads(r['payload_json'])} for r in db.execute('SELECT address,payload_json FROM platform_accounts')]
for r in db.execute('SELECT setting_key,payload_json FROM service_settings'):
    if r['setting_key'] in ['wallet_meta','platform_meta','a_token_pool_meta','a_token_kline_settings','lottery_amount_ranges','lottery_probabilities']:out['settings'][r['setting_key']]=json.loads(r['payload_json'])
names=['src/a-token-miner-service.js','src/a-token-staking-service.js','src/a-token-income.js','src/a-token-team-service.js','src/a-token-pool-service.js','src/a-token-service.js','src/a-token-ledger.js','src/a-token-revenue-service.js','src/a-token-transfer-service.js','src/a-token-order-service.js','src/a-token-api.js','src/a-token-admin-api.js','src/ai-managed-service.js','src/referral-service.js','src/lottery-service.js','src/platform-service.js','src/database.js','src/server.js','public/js/asset-manager.js','public/js/a-token.js','public/js/admin-a-token.js','public/js/admin.js','public/admin.html']
names+=['public/js/'+p.name for p in (root/'public/js').glob('*asset*.js')]
for name in sorted(set(names)):
    p=root/name
    if p.exists():
        b=p.read_bytes();out['sources'][name]={'sha256':hashlib.sha256(b).hexdigest(),'gzip_base64':base64.b64encode(gzip.compress(b)).decode()}
for d in (root/'backups').iterdir():
    if d.is_dir():
        for p in d.iterdir():
            if p.is_file() and (p.suffix in ['.sqlite','.db','.gz','.zip']):out['backup_inventory'].append({'path':str(p),'size':p.stat().st_size,'mtime':p.stat().st_mtime})
db.rollback();db.close()
encoded=base64.b64encode(gzip.compress(json.dumps(out,ensure_ascii=False,separators=(',',':')).encode())).decode()
print(json.dumps({'gzip_base64':encoded,'captured_at_utc':now.isoformat(),'day_start_beijing':start.isoformat(),'counts':{k:len(v) for k,v in out['tables'].items()},'users':len(out['users'])}))
