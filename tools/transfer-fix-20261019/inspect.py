import json, pathlib, subprocess, sqlite3
r=pathlib.Path('/opt/wg-platform')
a='0x72bf4d681f6ceae1ac8585546ae0fd7923a7b4f3'
out={}
for f in ['public/js/a-token-transfer.js','public/js/core.js','public/js/wallet.js']:
 s=(r/f).read_text(); out[f]=s if 'transfer' in f else '\n'.join(x[:500] for x in s.splitlines() if 'connectedProvider' in x or 'connectedWalletAddress' in x or 'signMessage' in x)
out['logs']=subprocess.run(['journalctl','-u','wg-platform','--since','24 hours ago','--no-pager','-n','600'],capture_output=True,text=True).stdout[-16000:]
c=sqlite3.connect('file:/var/lib/wg-platform/wg-platform.sqlite?mode=ro',uri=True)
for table in ['a_token_user_ids','a_token_transfers']:
 try:
  out[table+'Schema']=c.execute('select sql from sqlite_master where name=?',(table,)).fetchone()
  out[table]=c.execute('select * from '+table+' where '+('lower(wallet)=?' if 'user_ids' in table else 'lower(from_wallet)=? or lower(to_wallet)=?'),(a,) if 'user_ids' in table else (a,a)).fetchall()
 except Exception as e: out[table]=str(e)
print(json.dumps(out,ensure_ascii=False))
