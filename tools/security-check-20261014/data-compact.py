import base64, collections, datetime, hashlib, html, json, pathlib, re, sqlite3, urllib.parse
ROOT=pathlib.Path('/opt/wg-platform')
ZONE=datetime.timezone(datetime.timedelta(hours=8))
SINCE=int(datetime.datetime.fromisoformat('2026-10-11T03:09:25+08:00').timestamp()*1000)
TARGET='0xca667b94379ba32ea59727ddbfadabf5e2c28618'
pattern=re.compile(r'<\s*(?:script|iframe|object|embed|svg)\b|\bon(?:error|load|click|focus|mouseover)\s*=|(?:java|vb)script\s*:|data:(?:text/html|application/(?:java|ecma)script|image/svg\+xml)|/api/admin/(?:test-credits|withdrawals)|document\.cookie|localStorage|XMLHttpRequest',re.I)
def time(ms):return datetime.datetime.fromtimestamp(int(ms)/1000,ZONE).isoformat() if ms else None
def clean(v):
    if isinstance(v,dict):return {k:clean(x) for k,x in v.items() if not re.search(r'password|secret|signature|token_hash|cookie|authorization|private|session',k,re.I)}
    if isinstance(v,list):return [clean(x) for x in v]
    if isinstance(v,str):return v[:1200]
    return v
def convert(row):
    d=dict(row)
    for k in list(d):
        if k.endswith('_json'):
            try:d[k]=json.loads(d[k])
            except Exception:pass
        if k.endswith('_at') and isinstance(d[k],int):d[k]=time(d[k])
    return clean(d)
def indicators(value):
    if not isinstance(value,str):return []
    variants=[value]
    for _ in range(3):
        decoded=html.unescape(urllib.parse.unquote(variants[-1]))
        if decoded==variants[-1]:break
        variants.append(decoded)
    for candidate in list(variants):
        m=re.match(r'^data:[^,]*;base64,(.*)$',candidate,re.I|re.S)
        if m:
            try:variants.append(base64.b64decode(m[1],validate=True).decode('utf-8',errors='ignore'))
            except Exception:pass
    return sorted(set(m[0].lower() for c in variants for m in pattern.finditer(c)))
def valid_image(value):
    if not isinstance(value,str) or len(value)>950000:return False
    m=re.fullmatch(r'data:image/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})',value,re.I)
    if not m:return False
    try:
        d=base64.b64decode(m[2],validate=True)
        if not d or base64.b64encode(d).decode()!=m[2]:return False
        kind=m[1].lower()
        return d.startswith(b'\x89PNG\r\n\x1a\n') if kind=='png' else d.startswith(b'\xff\xd8\xff') if kind in ['jpg','jpeg'] else d[:6] in [b'GIF87a',b'GIF89a'] if kind=='gif' else d[:4]==b'RIFF' and d[8:12]==b'WEBP'
    except Exception:return False
out={'captured_beijing':datetime.datetime.now(ZONE).isoformat(),'readonly':True}
db=sqlite3.connect('file:'+str(ROOT/'wg-platform.sqlite')+'?mode=ro',uri=True,timeout=5)
db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
social=[];invalid=[];total=0
for r in db.execute('SELECT id,wallet,status,screenshot_url,created_at FROM social_submissions'):
    total+=1;value=r['screenshot_url'] or '';found=indicators(value)
    row={'id':r['id'],'wallet':r['wallet'],'status':r['status'],'created_beijing':time(r['created_at']),'indicators':found,'sha256':hashlib.sha256(value.encode()).hexdigest(),'length':len(value)}
    if not valid_image(value):invalid.append(row)
    if found:social.append(row)
support=[];recent_support=[];msg_total=0
for r in db.execute('SELECT m.id,m.sender,m.body,m.created_at,t.wallet FROM support_messages m LEFT JOIN support_tickets t ON t.id=m.ticket_id'):
    msg_total+=1;value=r['body'] or '';found=indicators(value)
    if found:support.append({'id':r['id'],'wallet':r['wallet'],'sender':r['sender'],'created_beijing':time(r['created_at']),'indicators':found,'sha256':hashlib.sha256(value.encode()).hexdigest()})
    if r['created_at']>=SINCE and r['wallet'] and r['wallet'].lower()==TARGET and not re.search('password|密码|私钥|token|cookie',value,re.I):
        recent_support.append({'id':r['id'],'sender':r['sender'],'time':time(r['created_at']),'text':value[:400]})
out.update(social_total=total,social_invalid=invalid,social_script_like=social,support_total=msg_total,support_script_like=support,target_support=recent_support)
out['non_usdt_deposits']=[convert(r) for r in db.execute("SELECT * FROM deposits WHERE asset!='USDT' ORDER BY created_at DESC")]
out['duplicate_confirmed_deposits']=[dict(r) for r in db.execute("SELECT network,lower(tx_hash) AS hash,COUNT(*) AS count FROM deposits WHERE status='confirmed' AND tx_hash!='' GROUP BY network,lower(tx_hash) HAVING COUNT(*)>1")]
out['deposits_by_asset_status']=[dict(r) for r in db.execute('SELECT asset,status,COUNT(*) AS count FROM deposits GROUP BY asset,status')]
out['withdrawals_since_cleanup']=[convert(r) for r in db.execute('SELECT * FROM withdrawals WHERE created_at>=? OR processed_at>=? ORDER BY created_at DESC',(SINCE,SINCE))]
out['funds_miner_grants']=[convert(r) for r in db.execute("SELECT event_id,address,created_at,payload_json FROM audit_log WHERE event_type='funds_miner_grant' AND created_at>=? ORDER BY created_at DESC",(SINCE,))]
out['target']={}
for table,col in [('wallet_users','address'),('platform_accounts','address'),('deposits','wallet'),('withdrawals','wallet'),('a_token_miners','wallet'),('a_token_transfers','from_wallet'),('a_token_transfers','to_wallet'),('audit_log','address'),('orders','address'),('fills','address'),('balance_adjustments','wallet')]:
    cols=[r[1] for r in db.execute('PRAGMA table_info("'+table+'")')]
    if col not in cols:continue
    timecol='created_at' if 'created_at' in cols else 'updated_at' if 'updated_at' in cols else 'started_at'
    out['target'][table+'_'+col]=[convert(r) for r in db.execute('SELECT * FROM "'+table+'" WHERE "'+col+'"=? COLLATE NOCASE ORDER BY "'+timecol+'" DESC LIMIT 80',(TARGET,))]
out['settings_script_like']=[]
for r in db.execute('SELECT setting_key,payload_json FROM service_settings'):
    if r['setting_key']=='wallet_account_blocks':continue
    found=indicators(r['payload_json'])
    if found:out['settings_script_like'].append({'key':r['setting_key'],'indicators':found})
out['security_source_checks']={}
checks={
 'src/server.js':['isLegacyFundsPath','FUNDS_ADMIN_REQUIRED','fundsAdminApi.handle','Content-Security-Policy'],
 'src/wallet-service.js':["assetConfig('USDT')",'该交易哈希已被其他账户','blockedWallets','wallet_account_blocks'],
 'src/lottery-service.js':['safeScreenshot','validateScreenshot','screenshotValid','screenshotUrl'],
 'public/js/admin-lottery.js':['document.write','sandbox','screenshotValid'],
 'public/js/operator-admin.js':['message.body','textContent =','textContent='],
 'public/js/support-chat.js':['message.body','textContent =','textContent='],
}
for name,markers in checks.items():
    src=(ROOT/name).read_text(errors='replace')
    out['security_source_checks'][name]={'sha256':hashlib.sha256(src.encode()).hexdigest(),'excerpts':[{'line':i+1,'text':s[:350]} for i,s in enumerate(src.splitlines()) if any(marker in s for marker in markers)][:80]}
out['recent_backups']=[{'name':p.name,'modified_beijing':datetime.datetime.fromtimestamp(p.stat().st_mtime,ZONE).isoformat()} for p in sorted((ROOT/'backups').glob('*'),key=lambda p:p.stat().st_mtime,reverse=True)[:15]]
db.rollback();db.close()
for key in ['withdrawals_since_cleanup','funds_miner_grants']:
    out[key]=[{k:v for k,v in row.items() if k!='payload_json'} for row in out[key]]
for key,rows in out['target'].items():
    if key not in ['wallet_users_address','platform_accounts_address','deposits_wallet','balance_adjustments_wallet']:
        out['target'][key]=[{k:v for k,v in row.items() if k!='payload_json'} for row in rows]
out['security_source_checks']={k:{'sha256':v['sha256'],'excerpts':v['excerpts'][:15]} for k,v in out['security_source_checks'].items()}
print(json.dumps(out,ensure_ascii=False,separators=(',',':')))
