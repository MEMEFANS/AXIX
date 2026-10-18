import datetime
import json
import sqlite3

wallets = [
    '0x614c4fba35aae54b40d4db7089521327e88d152c',
    '0xd08f17eac2760041c26c93c026dff95cb8b41108',
    '0xebd85ce5e40a5ba3da113662b4ad6277e131b7b9',
    '0xa26bc28f6b574f8d3fe0bf03b3c5e69e09b46330',
]
db = sqlite3.connect('file:/opt/wg-platform/wg-platform.sqlite?mode=ro', uri=True, timeout=5)
db.row_factory = sqlite3.Row
db.execute('PRAGMA query_only=ON')
db.execute('BEGIN')
out = {'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exceptions':[],'database_read_only':True}
for wallet in wallets:
    activations = []
    for row in db.execute('SELECT id,plan,status,confirmed_at,payload_json FROM a_token_activations WHERE wallet=? COLLATE NOCASE', (wallet,)):
        payload = json.loads(row['payload_json'])
        detail = payload.get('payload') or {}
        activations.append({'id':row['id'],'plan':row['plan'],'status':row['status'],'confirmed_at':row['confirmed_at'],'reject_reason':detail.get('rejectReason'),'miner_plan':detail.get('minerPlan')})
    grants = []
    for row in db.execute("SELECT event_id,event_type,created_at,payload_json FROM audit_log WHERE address=? COLLATE NOCASE AND event_type LIKE '%miner%'", (wallet,)):
        payload = json.loads(row['payload_json'])
        grants.append({'event_id':row['event_id'],'event_type':row['event_type'],'created_at':row['created_at'],'plan':payload.get('plan'),'miner_id':payload.get('minerId'),'note':payload.get('note')})
    out['exceptions'].append({'wallet':wallet,'activations':activations,'miner_audits':grants})
db.rollback()
db.close()
print(json.dumps(out, ensure_ascii=False, indent=2))
