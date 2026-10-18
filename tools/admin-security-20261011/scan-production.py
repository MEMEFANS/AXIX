import base64
import collections
import datetime
import gzip
import hashlib
import html
import json
import pathlib
import re
import sqlite3
import urllib.parse

root = pathlib.Path('/opt/wg-platform')
db = sqlite3.connect('file:' + str(root / 'wg-platform.sqlite') + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
db.execute('PRAGMA query_only=ON')
db.execute('BEGIN')
pattern = re.compile(r'<\s*(?:script|iframe|object|embed|svg)\b|\bon(?:error|load|click|focus|mouseover)\s*=|(?:java|vb)script\s*:|data:(?:text/html|application/(?:java|ecma)script|image/svg\+xml)|/api/admin/(?:test-credits|withdrawals)', re.I)
def indicators(value):
    variants = [value]
    for _ in range(3):
        decoded = html.unescape(urllib.parse.unquote(variants[-1]))
        if decoded == variants[-1]:
            break
        variants.append(decoded)
    for candidate in list(variants):
        match = re.match(r'^data:[^,]*;base64,(.*)$', candidate, re.I | re.S)
        if match:
            try:
                variants.append(base64.b64decode(match[1], validate=True).decode('utf-8', errors='ignore'))
            except Exception:
                pass
    return sorted(set(match.group(0).lower() for candidate in variants for match in pattern.finditer(candidate)))
def valid_image(value):
    if not isinstance(value, str) or len(value) > 950000:
        return False
    match = re.fullmatch(r'data:image/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})', value, re.I)
    if not match:
        return False
    try:
        data = base64.b64decode(match[2], validate=True)
        if not data or base64.b64encode(data).decode('ascii') != match[2]:
            return False
        kind = match[1].lower()
        return data.startswith(b'\x89PNG\r\n\x1a\n') if kind == 'png' else data.startswith(b'\xff\xd8\xff') if kind in ['jpeg','jpg'] else data[:6] in [b'GIF87a',b'GIF89a'] if kind == 'gif' else data[:4] == b'RIFF' and data[8:12] == b'WEBP'
    except Exception:
        return False
social = []
invalid_kinds = collections.Counter()
total_social = 0
for row in db.execute('SELECT id,wallet,status,screenshot_url,created_at FROM social_submissions'):
    total_social += 1
    value = row['screenshot_url'] or ''
    if not valid_image(value):
        invalid_kinds['empty' if not value else 'legacy_http_url' if re.match(r'^https?://',value,re.I) else 'non_raster_data_url' if value.lower().startswith('data:') else 'legacy_text'] += 1
        social.append({'id':row['id'], 'wallet':row['wallet'], 'status':row['status'], 'created_at':row['created_at'], 'indicators':indicators(value), 'sha256':hashlib.sha256(value.encode()).hexdigest(), 'length':len(value)})
support = []
total_messages = 0
for row in db.execute('SELECT m.id,m.ticket_id,m.sender,m.body,m.created_at,t.wallet FROM support_messages m LEFT JOIN support_tickets t ON t.id=m.ticket_id'):
    total_messages += 1
    found = indicators(row['body'] or '')
    if found:
        support.append({'id':row['id'], 'ticket_id':row['ticket_id'], 'wallet':row['wallet'], 'sender':row['sender'], 'created_at':row['created_at'], 'indicators':found, 'sha256':hashlib.sha256((row['body'] or '').encode()).hexdigest()})
files = {}
for name in ['src/server.js','src/lottery-service.js','src/lottery-api.js','src/support-service.js','src/support-api.js','src/admin-auth.js','src/wallet-service.js','public/admin.html','public/withdraw-admin.html','public/js/admin-lottery.js','public/js/operator-admin.js','public/js/support-chat.js','public/js/admin-community.js','public/js/admin-agents.js']:
    data = (root / name).read_bytes()
    files[name] = {'sha256':hashlib.sha256(data).hexdigest(), 'gzip_base64':base64.b64encode(gzip.compress(data)).decode('ascii')}
out = {'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'readonly':True, 'social_total':total_social, 'social_invalid':social, 'invalid_kinds':dict(invalid_kinds), 'invalid_statuses':dict(collections.Counter(item['status'] for item in social)), 'support_messages_total':total_messages, 'support_script_like_messages':support, 'files':files}
db.rollback()
db.close()
print(json.dumps(out, ensure_ascii=False))
