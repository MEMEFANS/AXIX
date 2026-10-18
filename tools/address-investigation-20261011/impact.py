import sqlite3,json,re,datetime,hashlib,os
W='0xd36ddfb9d3fa6b326b49e6eab68c5b961bc3ba59'; R='0xf75a7c032b7a484269ced5663f7fa10acf63b1ac'
db=sqlite3.connect('file:/opt/wg-platform/wg-platform.sqlite?mode=ro',uri=True);db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
out={'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'related_wallet_records':{},'malicious_payload_summary':{}}
for table,col in [('withdrawals','wallet'),('deposits','wallet'),('a_token_trades','wallet'),('orders','address'),('fills','address'),('balance_adjustments','wallet'),('a_token_claims','wallet')]:
    rows=[]
    for r in db.execute('SELECT * FROM '+table+' WHERE '+col+'=? COLLATE NOCASE ORDER BY created_at LIMIT 50',(R,)):
        p=dict(r)
        data=json.loads(p.pop('payload_json','{}'));data={k:v for k,v in data.items() if k in ['id','wallet','requestId','network','asset','amount','amountUnits','feeUnits','netAmountUnits','status','txHash','createdAt','processedAt','reason','rejectReason','failReason','error','toAddress','automaticApproved']};p['payload']=data;rows.append(p)
    out['related_wallet_records'][table]=rows
stats={'count':0,'associated_with_target':0,'related_wallet_count':0,'wallets':set(),'target_endpoints':{},'latest_created_at':0,'latest_target_created_at':0,'counts_by_status':{},'payload_groups':{}}
for r in db.execute('SELECT wallet,screenshot_url,status,created_at FROM social_submissions'):
    s=r['screenshot_url']
    if not re.search(r'<\w|onerror\s*=|javascript:|<script',s,re.I): continue
    stats['count']+=1;stats['wallets'].add(r['wallet']);stats['associated_with_target']+=W in s.lower();stats['related_wallet_count']+=R in s.lower();stats['latest_created_at']=max(stats['latest_created_at'],r['created_at']);stats['counts_by_status'][r['status']]=stats['counts_by_status'].get(r['status'],0)+1
    if W in s.lower(): stats['latest_target_created_at']=max(stats['latest_target_created_at'],r['created_at'])
    # Group on indicators only; do not export executable payloads.
    endpoints=sorted(set(re.findall(r'/api/[a-zA-Z0-9_/-]+',s)))
    for e in endpoints:stats['target_endpoints'][e]=stats['target_endpoints'].get(e,0)+1
    h=hashlib.sha256(s.encode()).hexdigest();g=stats['payload_groups'].setdefault(h,{'count':0,'first':r['created_at'],'last':r['created_at'],'endpoints':endpoints,'contains_target':W in s.lower(),'contains_related':R in s.lower()});g['count']+=1;g['first']=min(g['first'],r['created_at']);g['last']=max(g['last'],r['created_at'])
stats['wallet_count']=len(stats.pop('wallets'));stats['payload_group_count']=len(stats['payload_groups']);out['malicious_payload_summary']=stats
out['withdrawal_frozen_code']={}
for file in ['src/wallet-service.js','src/a-token-service.js','src/a-token-claim-service.js','src/a-token-admin-api.js']:
    p='/opt/wg-platform/'+file
    if not os.path.exists(p):continue
    lines=open(p).read().splitlines();chosen={}
    for i,line in enumerate(lines):
        if re.search(r'withdrawalFrozen|withdrawFrozen|setWithdraw.*Enabled|withdrawEnabled|withdraw/mode|a-token-meta|withdrawal-automation|function balanceA|function isWithdrawalFrozen',line,re.I):
            for j in range(max(0,i-2),min(len(lines),i+4)):chosen[j+1]=lines[j]
    out['withdrawal_frozen_code'][file]=[{'line':n,'text':text} for n,text in chosen.items()][:100]
db.rollback();db.close();print(json.dumps(out,ensure_ascii=False,indent=2))
