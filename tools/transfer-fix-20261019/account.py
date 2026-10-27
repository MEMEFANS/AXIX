import sqlite3,json,pathlib
c=sqlite3.connect('file:/var/lib/wg-platform/wg-platform.sqlite?mode=ro',uri=True);a='0x72bf4d681f6ceae1ac8585546ae0fd7923a7b4f3';out={}
for (name,sql) in c.execute("select name,sql from sqlite_master where type='table'"):
 if name in ['wallet_users','wallet_balances'] or 'meta' in name or 'state' in name:
  if name=='wallet_users':out[name]=c.execute('select * from '+name+' where lower(address)=?',(a,)).fetchall()
  elif name=='wallet_balances':out[name]=c.execute('select * from '+name+' where lower(wallet)=?',(a,)).fetchall()
  elif 'wallet' in name:
   rows=c.execute('select * from '+name).fetchall();out[name]=[str(x)[:1000] for x in rows if a in str(x).lower()]
print(json.dumps(out,ensure_ascii=False))
