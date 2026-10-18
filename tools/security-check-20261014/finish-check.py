import collections, datetime, json, re, sqlite3, subprocess
ZONE=datetime.timezone(datetime.timedelta(hours=8))
def time(ms):return datetime.datetime.fromtimestamp(int(ms)/1000,ZONE).isoformat() if ms else None
db=sqlite3.connect('file:/opt/wg-platform/wg-platform.sqlite?mode=ro',uri=True,timeout=5)
db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
w='0xca667b94379ba32ea59727ddbfadabf5e2c28618'
out={'captured_beijing':datetime.datetime.now(ZONE).isoformat(),'readonly':True}
out['target_deposits']=[dict(r) for r in db.execute('SELECT id,asset,network,tx_hash,amount_units,status,created_at,confirmed_at FROM deposits WHERE wallet=? COLLATE NOCASE ORDER BY created_at',(w,))]
out['target_withdrawals']=[dict(r) for r in db.execute('SELECT id,asset,amount_units,status,tx_hash,created_at,processed_at FROM withdrawals WHERE wallet=? COLLATE NOCASE',(w,))]
out['target_fills']=[dict(r) for r in db.execute('SELECT id,symbol,product,side,created_at FROM orders WHERE address=? COLLATE NOCASE',(w,))]
out['target_balances']=[json.loads(r[0]).get('balances') for r in db.execute('SELECT payload_json FROM wallet_users WHERE address=? COLLATE NOCASE',(w,))]
out['other_non_usdt_deposits']=[dict(r) for r in db.execute("SELECT wallet,asset,amount_units,status,tx_hash,created_at FROM deposits WHERE asset!='USDT'")]
out['duplicate_deposits']=[dict(r) for r in db.execute("SELECT network,lower(tx_hash) AS hash,COUNT(*) AS count FROM deposits WHERE status='confirmed' GROUP BY network,lower(tx_hash) HAVING COUNT(*)>1")]
db.rollback();db.close()
j=subprocess.run(['journalctl','-u','ssh','-u','sshd','--since','24 hours ago','--no-pager','-o','json'],capture_output=True,text=True,timeout=20)
accepted=collections.Counter();first={};last={};failures=collections.Counter()
for line in j.stdout.splitlines():
    try:r=json.loads(line)
    except Exception:continue
    msg=r.get('MESSAGE','');m=re.search(r'Accepted (\S+) for (\S+) from (\S+)',msg)
    if m:
        key=' '.join(m.groups());accepted[key]+=1
        when=time(int(r['__REALTIME_TIMESTAMP'])//1000)
        first.setdefault(key,when);last[key]=when
    if 'Failed password' in msg:
        failures['failed_password_events']+=1
        if int(r['__REALTIME_TIMESTAMP'])/1e6>=datetime.datetime.now().timestamp()-3600:failures['failed_password_last_hour']+=1
out['ssh_accepted']=[{'source':k,'count':v,'first':first[k],'last':last[k]} for k,v in accepted.items()]
out['ssh_failures']=dict(failures)
print(json.dumps(out,ensure_ascii=False,separators=(',',':')))
