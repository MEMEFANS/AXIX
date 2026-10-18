import sqlite3, json, datetime, os, re

ADDRESS = '0xd36ddfb9d3fa6b326b49e6eab68c5b961bc3ba59'
db = sqlite3.connect('file:/opt/wg-platform/wg-platform.sqlite?mode=ro', uri=True)
db.row_factory = sqlite3.Row
db.execute('PRAGMA query_only=ON')
db.execute('BEGIN')

def clean(v):
    if isinstance(v, dict):
        return {k: clean(x) for k, x in v.items() if not re.search(r'(signature|token_hash|session|password|private|secret|authorization|cookie)', k, re.I)}
    if isinstance(v, list):
        return [clean(x) for x in v]
    return v

def convert(row):
    out = dict(row)
    for k in list(out):
        if k.endswith('_json'):
            try: out[k] = json.loads(out[k])
            except Exception: pass
    return clean(out)

out = {'address': ADDRESS, 'captured_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'db': '/opt/wg-platform/wg-platform.sqlite', 'accounts': {}, 'tables': {}}
tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
for table in tables:
    if table in ['wallet_sessions', 'permit_signatures']: continue
    cols = [r[1] for r in db.execute('PRAGMA table_info("'+table+'")')]
    address_cols = [c for c in cols if c in ['address','wallet','from_wallet','to_wallet','recipient_wallet','source_wallet','referrer_wallet']]
    if not address_cols: continue
    where = ' OR '.join('"'+c+'"=? COLLATE NOCASE' for c in address_cols)
    params = [ADDRESS]*len(address_cols)
    count = db.execute('SELECT COUNT(*) FROM "'+table+'" WHERE '+where, params).fetchone()[0]
    if table in ['wallet_users','platform_accounts','a_token_user_ids','a_token_team_levels','lottery_accounts','airdrop_points_accounts','platform_referral_links']:
        out['accounts'][table] = [convert(r) for r in db.execute('SELECT * FROM "'+table+'" WHERE '+where+' LIMIT 5',params)]
    meta = {'count':count, 'address_columns':address_cols}
    time_col = next((c for c in ['created_at','released_at','settled_at','started_at','updated_at'] if c in cols), None)
    if count and time_col:
        times = db.execute('SELECT MIN("'+time_col+'"), MAX("'+time_col+'") FROM "'+table+'" WHERE '+where,params).fetchone()
        meta['first_last_ms'] = list(times)
    if count and table not in out['accounts']:
        order = ' ORDER BY "'+time_col+'" DESC' if time_col else ''
        meta['latest_samples'] = [convert(r) for r in db.execute('SELECT * FROM "'+table+'" WHERE '+where+order+' LIMIT 2',params)]
    out['tables'][table] = meta
db.rollback()
db.close()
print(json.dumps(out, ensure_ascii=False, indent=2))
