import base64
import datetime
import hashlib
import json
import pathlib
import re
import sqlite3

root = pathlib.Path('/opt/wg-platform')
db = sqlite3.connect('file:' + str(root / 'wg-platform.sqlite') + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
db.execute('PRAGMA query_only=ON')
out = []
for identifier in ['ss_3ca9f7559510856c8311','ss_f0178e4ea0f6a05e8e26']:
    row = db.execute('SELECT * FROM social_submissions WHERE id=?',(identifier,)).fetchone()
    if not row:
        continue
    source = row['screenshot_url'] or ''
    match = re.match(r'^data:([^,]+),(.*)$', source, re.I)
    decoded = base64.b64decode(match[2]).decode('utf-8',errors='replace') if match and ';base64' in match[1].lower() else match[2] if match else source
    account = db.execute('SELECT balances_json FROM wallet_users WHERE lower(address)=?',(row['wallet'].lower(),)).fetchone()
    adjustment = db.execute("SELECT COUNT(*) AS count FROM balance_adjustments WHERE lower(wallet)=?",(row['wallet'].lower(),)).fetchone()
    out.append({'id':row['id'],'wallet':row['wallet'],'status':row['status'],'reviewer':row['reviewer'],'points_awarded':row['points_awarded'],'created_at_utc':datetime.datetime.fromtimestamp(row['created_at']/1000,datetime.timezone.utc).isoformat(),'source_mime':match[1] if match else '', 'decoded_length':len(decoded), 'decoded_sha256':hashlib.sha256(decoded.encode()).hexdigest(), 'simple_alert_only':bool(re.fullmatch(r'\s*<script>\s*alert\(\d+\);?\s*</script>\s*',decoded,re.I) or re.fullmatch(r'\s*<svg\s+onload\s*=\s*["\']?alert\(\d+\)["\']?\s*>\s*',decoded,re.I)), 'network_or_cookie_access':bool(re.search(r'fetch\s*\(|XMLHttpRequest|document\.cookie|localStorage|sessionStorage|/api/',decoded,re.I)), 'balances':json.loads(account['balances_json']) if account else None,'balance_adjustments_count':adjustment['count']})
db.close()
print(json.dumps({'readonly':True,'records':out},ensure_ascii=False))
