import collections
import base64
import datetime
import gzip
import json
import pathlib
import sqlite3

ROOT = '0x7d1159b9f72f4f15493773e4473b9555ae73ac29'
EXCLUDED_PREFIX, EXCLUDED_SUFFIX = '0xe9ee64', '55f06a'
tz = datetime.timezone(datetime.timedelta(hours=8))
start = datetime.datetime(2026, 10, 6, tzinfo=tz)
start_ms = int(start.timestamp() * 1000)
db = sqlite3.connect('file:/opt/wg-platform/wg-platform.sqlite?mode=ro', uri=True, timeout=15)
db.row_factory = sqlite3.Row
db.execute('PRAGMA query_only=ON')
db.execute('BEGIN')
captured = datetime.datetime.now(datetime.timezone.utc)
links = [dict(row) for row in db.execute('SELECT wallet,referrer_wallet,created_at FROM platform_referral_links')]
by_wallet = {row['wallet'].lower():row for row in links}
children = collections.defaultdict(list)
for row in links:
    children[(row['referrer_wallet'] or '').lower()].append(row['wallet'].lower())
directs = sorted(children[ROOT], key=lambda w:(by_wallet[w]['created_at'], w))
excluded = [w for w in directs if w.startswith(EXCLUDED_PREFIX) and w.endswith(EXCLUDED_SUFFIX)]
assert len(excluded) == 1, 'Excluded direct prefix/suffix must resolve exactly once'
assert ROOT in by_wallet, 'Requested root is not present in referral graph'
members = {}
anomalies = []
for branch in directs:
    queue = collections.deque([(branch, 1)])
    visited = {ROOT}
    while queue:
        wallet, depth = queue.popleft()
        if wallet in visited or wallet in members:
            anomalies.append({'branch':branch,'wallet':wallet,'depth':depth})
            continue
        visited.add(wallet)
        members[wallet] = {'branch':branch,'depth':depth,'excluded':branch in excluded}
        queue.extend((child, depth + 1) for child in children[wallet])
included_members = {w:info for w,info in members.items() if not info['excluded']}
scope = set(included_members) | {ROOT}
miners = []
for row in db.execute('SELECT id,wallet,plan,started_at,expires_at,status FROM a_token_miners'):
    if row['wallet'].lower() in scope:
        miners.append(dict(row))
activations = []
for row in db.execute('SELECT id,wallet,plan,bnb_amount_wei,tx_hash,block_number,status,confirmed_at,created_at FROM a_token_activations'):
    if row['wallet'].lower() in scope:
        activations.append(dict(row))
tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
grants = []
if 'a_token_miner_grants' in tables:
    columns = {row['name'] for row in db.execute('PRAGMA table_info(a_token_miner_grants)')}
    selected = [name for name in ['id','wallet','plan','miner_id','created_at','status'] if name in columns]
    if 'wallet' in selected:
        for row in db.execute('SELECT ' + ','.join(selected) + ' FROM a_token_miner_grants'):
            if row['wallet'].lower() in scope:
                grants.append(dict(row))
out = {
    'root':ROOT, 'start_beijing':start.isoformat(), 'start_ms':start_ms,
    'captured_at_utc':captured.isoformat(), 'captured_at_beijing':captured.astimezone(tz).isoformat(),
    'excluded_branch':excluded[0], 'directs':[by_wallet[w] for w in directs],
    'members':[{ 'wallet':w, 'referrer_wallet':by_wallet[w]['referrer_wallet'], 'joined_at':by_wallet[w]['created_at'], **info } for w,info in included_members.items()],
    'excluded_member_count':sum(1 for info in members.values() if info['excluded']),
    'miners':miners, 'activations':activations, 'miner_grants':grants, 'graph_anomalies':anomalies,
    'database_read_only':True, 'database_writes':False,
}
db.rollback()
db.close()
encoded = base64.b64encode(gzip.compress(json.dumps(out, ensure_ascii=False, separators=(',',':')).encode('utf-8'))).decode('ascii')
print(json.dumps({'gzip_base64':encoded,'captured_at_beijing':out['captured_at_beijing'],'counts':{'directs':len(directs),'included_members':len(included_members),'miners':len(miners),'activations':len(activations)}}))
