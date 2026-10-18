import sqlite3, json, datetime, re, hashlib, os, glob
W='0xd36ddfb9d3fa6b326b49e6eab68c5b961bc3ba59'
db=sqlite3.connect('file:/opt/wg-platform/wg-platform.sqlite?mode=ro',uri=True)
db.row_factory=sqlite3.Row
db.execute('PRAGMA query_only=ON'); db.execute('BEGIN')
def sha(s): return hashlib.sha256(s.encode()).hexdigest()
def ts(ms): return datetime.datetime.fromtimestamp(ms/1000,datetime.timezone(datetime.timedelta(hours=8))).isoformat() if ms else None
def safe(v):
    if isinstance(v,dict): return {k:safe(x) for k,x in v.items() if not re.search(r'password|secret|signature|cookie|session|private|token|signer',k,re.I)}
    if isinstance(v,list): return [safe(x) for x in v]
    if isinstance(v,str):
        if '<' in v or 'onerror' in v.lower() or len(v)>400: return {'length':len(v),'sha256':sha(v),'contains_markup':bool(re.search(r'<\w|onerror',v,re.I))}
    return v
out={'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'social_submissions':[],'callback_flows':[]}
for r in db.execute('SELECT id,wallet,platform,status,created_at,screenshot_url FROM social_submissions WHERE wallet=? COLLATE NOCASE ORDER BY created_at',(W,)):
    p=dict(r); s=p.pop('screenshot_url'); p['time_beijing']=ts(p['created_at']);p['payload_sha256']=sha(s);p['payload_length']=len(s)
    p['event_handler_injection']=bool(re.search(r'onerror\s*=',s,re.I))
    p['target_endpoints']=sorted(set(re.findall(r'/api/[a-zA-Z0-9_/-]+',s)))
    p['recipient_wallets']=sorted(set(re.findall(r'0x[0-9a-fA-F]{40}',s)))
    p['requested_amounts']=re.findall(r"amount\s*:\s*['\"]([0-9.]+)['\"]",s)
    p['requested_agent_names']=re.findall(r"username\s*:\s*['\"]([a-zA-Z0-9_-]+)['\"]",s)
    out['social_submissions'].append(p)
for r in db.execute('SELECT id,change,balance,type,note,created_at FROM lottery_flows WHERE wallet=? COLLATE NOCASE ORDER BY created_at',(W,)):
    p=dict(r); note=p.pop('note'); label=note.split(' ',1)[0];p['time_beijing']=ts(p['created_at']);p['note_sha256']=sha(note);p['note_length']=len(note);p['callback_label']=label
    if re.search(r'COOKIE|\bLS\b|SESS|USERS|AGENTS|DEP|DASH|WDR|OPBR',label,re.I):
        p['callback_content']='redacted';p['reports_ok']=bool(re.search(r'"ok"\s*:\s*true',note));p['reports_unauthorized']='AUTH' in note or '认证' in note
    else:
        try: p['callback_result']=safe(json.loads(note.split(' ',1)[1]))
        except Exception:
            p['reports_ok']=bool(re.search(r'"ok"\s*:\s*true',note));p['reports_unauthorized']='AUTH' in note or '认证' in note
    out['callback_flows'].append(p)
out['agent_accounts']=[dict(r) for r in db.execute('SELECT id,username,wallet_address,status,created_at,created_by FROM agent_accounts WHERE wallet_address=? COLLATE NOCASE OR username LIKE ?',(W,'svcops%'))]
out['ticket_messages']=[]
for r in db.execute('SELECT m.id,m.sender,m.created_at,m.body FROM support_messages m JOIN support_tickets t ON m.ticket_id=t.id WHERE t.wallet=? COLLATE NOCASE ORDER BY m.created_at',(W,)):
    p=dict(r); body=p.pop('body');p['time_beijing']=ts(p['created_at']);p['body_sha256']=sha(body);p['body_length']=len(body);p['contains_markup']=bool(re.search(r'<\w|onerror',body,re.I));p['involves_admin']=bool(re.search(r'admin|后台|余额|截图|任务',body,re.I));out['ticket_messages'].append(p)
out['settings']=[]
for r in db.execute('SELECT setting_key,payload_json,updated_at FROM service_settings'):
    if re.search(r'withdraw|community|security|automation|grant',r['setting_key'],re.I):
        try: p=json.loads(r['payload_json'])
        except Exception: p={}
        out['settings'].append({'key':r['setting_key'],'updated_at':r['updated_at'],'time_beijing':ts(r['updated_at']),'data':safe(p)})
out['all_adjustments_in_incident_window']=[dict(r) for r in db.execute('SELECT id,wallet,asset,amount_units,adjustment_type,reason,admin_username,created_at FROM balance_adjustments WHERE created_at BETWEEN ? AND ? ORDER BY created_at LIMIT 150',(1791582000000,1791657600000))]
out['nginx_log_files']=[{'path':p,'size':os.stat(p).st_size} for p in glob.glob('/var/log/nginx/*') if os.path.isfile(p)]
out['app_log_files']=[{'path':p,'size':os.stat(p).st_size} for p in glob.glob('/opt/wg-platform/logs/*') if os.path.isfile(p)]
out['server_files']={p:{'size':os.stat('/opt/wg-platform/'+p).st_size,'mtime':os.stat('/opt/wg-platform/'+p).st_mtime,'sha256':hashlib.sha256(open('/opt/wg-platform/'+p,'rb').read()).hexdigest()} for p in ['src/server.js','src/database.js','src/lottery-service.js','public/admin.html','public/js/admin.js'] if os.path.exists('/opt/wg-platform/'+p)}
db.rollback();db.close()
print(json.dumps(out,ensure_ascii=False,indent=2))
