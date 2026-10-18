import base64
import collections
import gzip
import json
import sqlite3

root = '0x7d1159b9f72f4f15493773e4473b9555ae73ac29'
excluded = '0xe9ee6473942671b1779b60c0bafd850ccf55f06a'
db = sqlite3.connect('file:/opt/wg-platform/wg-platform.sqlite?mode=ro', uri=True, timeout=5)
db.row_factory = sqlite3.Row
db.execute('PRAGMA query_only=ON')
db.execute('BEGIN')
children = collections.defaultdict(list)
for row in db.execute('SELECT wallet,referrer_wallet FROM platform_referral_links'):
    children[(row['referrer_wallet'] or '').lower()].append(row['wallet'].lower())
members = set()
queue = collections.deque(w for w in children[root] if w != excluded)
while queue:
    wallet = queue.popleft()
    if wallet in members or wallet in [root, excluded]:
        continue
    members.add(wallet)
    queue.extend(children[wallet])
activations = []
for row in db.execute('SELECT id,wallet,plan,payload_json FROM a_token_activations'):
    if row['wallet'].lower() not in members:
        continue
    payload = json.loads(row['payload_json'])
    detail = payload.get('payload') or {}
    activations.append({'id':row['id'],'wallet':row['wallet'],'plan':row['plan'],'collection_address':detail.get('collectionAddress')})
audits = []
for row in db.execute("SELECT event_id,address,event_type,created_at,payload_json FROM audit_log WHERE event_type IN ('funds_miner_grant','admin_miner_grant','a_token_miner_grant','activation_confirm')"):
    if (row['address'] or '').lower() not in members:
        continue
    payload = json.loads(row['payload_json'])
    audits.append({'event_id':row['event_id'],'wallet':row['address'],'event_type':row['event_type'],'created_at':row['created_at'],'plan':payload.get('plan'),'miner_id':(payload.get('miner') or {}).get('id'),'activation_id':payload.get('activationId')})
db.rollback()
db.close()
out = {'activations':activations,'audits':audits,'database_read_only':True}
print(json.dumps({'gzip_base64':base64.b64encode(gzip.compress(json.dumps(out).encode())).decode()}))
