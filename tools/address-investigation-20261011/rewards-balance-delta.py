import sqlite3,json,pathlib,datetime,collections,os
root=pathlib.Path('/opt/wg-platform');snap=root/'backups/incident-cleanup-20261011-030921/before.sqlite'
before=sqlite3.connect('file:'+str(snap)+'?mode=ro',uri=True);after=sqlite3.connect('file:'+str(root/'wg-platform.sqlite')+'?mode=ro',uri=True)
for db in [before,after]:db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
def rows(db,table,key='id'):
    return {r[key]:dict(r) for r in db.execute('SELECT * FROM '+table)}
def users(db):
    return {r['address'].lower():json.loads(r['payload_json']).get('balances',{}) for r in db.execute('SELECT address,payload_json FROM wallet_users')}
old=users(before);new=users(after);blocks=set(json.loads(after.execute("SELECT payload_json FROM service_settings WHERE setting_key='wallet_account_blocks'").fetchone()[0])['wallets'])
delta=collections.defaultdict(int);parts=collections.defaultdict(lambda:collections.defaultdict(int));changed={}
def add(wallet,amount,source):
    wallet=wallet.lower();amount=int(amount);delta[wallet]+=amount;parts[wallet][source]+=amount
def row_changes(t):
    a=rows(before,t);b=rows(after,t);changed[t]={'new':sum(k not in a for k in b),'removed':sum(k not in b for k in a),'modified':sum(a[k]!=b[k] for k in a.keys()&b.keys())};return a,b
for t,owner in [('a_token_miner_releases','wallet'),('a_token_stake_rewards','wallet'),('a_token_team_rewards','recipient_wallet'),('a_token_direct_count_rewards','recipient_wallet')]:
    a,b=row_changes(t)
    for key,r in b.items():add(r[owner],int(r['amount_units'])-int(a.get(key,{}).get('amount_units','0')),t)
for t in ['a_token_transfers','a_token_trades','balance_adjustments','lottery_wins','a_token_stakes','a_token_orders','a_token_withdrawals','a_token_claims','ai_managed_batches']:
    a,b=row_changes(t)
    if t=='a_token_transfers':
        for key,r in b.items():
            if key not in a:
                add(r['from_wallet'],-int(r['amount_units']),t);add(r['to_wallet'],int(r['amount_units'])-int(r['fee_units']),t)
    elif t=='a_token_trades':
        for key,r in b.items():
            if key not in a:add(r['wallet'],int(r['size_units']) if r['side']=='buy' else -int(r['size_units'])-int(r['fee_units']),t)
    elif t=='balance_adjustments':
        for key,r in b.items():
            if key not in a and r['asset']=='A':add(r['wallet'],(-1 if 'debit' in r['adjustment_type'] else 1)*int(r['amount_units']),t)
    elif t=='lottery_wins':
        from decimal import Decimal
        for key,r in b.items():
            if key not in a and r['prize_type']=='crypto' and r['symbol'] in ['AIX','A']:add(r['wallet'],int(Decimal(str(r['amount']))*10**18),t)
    elif t=='a_token_stakes':
        for key,r in b.items():
            if key not in a:add(r['wallet'],-int(r['principal_units']),t)
            if r['plan_id']=='current' and r['status']=='completed' and (key not in a or a[key]['status']=='active'):add(r['wallet'],r['principal_units'],t)
    elif t=='a_token_orders':
        for dbrows,sign in [(a,1),(b,-1)]:
            for r in dbrows.values():
                if r['status']=='OPEN':add(r['wallet'],sign*int(r['input_a_units']),t)
    elif t in ['a_token_withdrawals','a_token_claims','ai_managed_batches']:
        # Report these explicitly rather than guessing ledger movements from an unknown state transition.
        pass
unexplained=[];changes=[]
for wallet,balances in new.items():
    observed=int(balances.get('A','0'))-int(old.get(wallet,{}).get('A','0'));expected=delta.get(wallet,0)
    if observed or expected:changes.append({'wallet':wallet,'observed_units':str(observed),'expected_units':str(expected),'parts':{k:str(v) for k,v in parts[wallet].items() if v}})
    if observed!=expected:unexplained.append(changes[-1] if changes and changes[-1]['wallet']==wallet else {'wallet':wallet,'observed_units':str(observed),'expected_units':str(expected)})
out={'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'baseline':str(snap),'baseline_captured_beijing':'2026-10-11 03:09:21','users_now':len(new),'normal_accounts_missing':sorted(set(old)-blocks-set(new)),'deleted_accounts_reappeared':sorted(blocks&set(new)),'normal_AIX_balance_changes':changes,'unexplained_AIX_changes':unexplained,'table_changes':changed,'new_zero_balance_users':sum(w not in old and int(b.get('A','0'))==0 for w,b in new.items())}
for db in [before,after]:db.rollback();db.close()
print(json.dumps(out,ensure_ascii=False,indent=2))
