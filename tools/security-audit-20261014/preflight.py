import pathlib,json,hashlib,subprocess,sqlite3
r=pathlib.Path('/opt/wg-platform');d=pathlib.Path('/var/lib/wg-platform')
h=lambda p:hashlib.sha256(p.read_bytes().replace(b'\r\n',b'\n')).hexdigest()
files=['src/a-token-withdrawal-service.js','src/a-token-claim-service.js','src/a-token-miner-service.js','src/database.js','src/server.js','src/a-token-api.js','package.json','package-lock.json']
out={'files':{f:h(r/f) for f in files},'service':subprocess.check_output(['systemctl','show','wg-platform','-p','ActiveState,SubState,MainPID,NRestarts,User,Environment'],text=True),'node':subprocess.check_output(['node','--version'],text=True).strip()}
with sqlite3.connect('file:'+str(d/'wg-platform.sqlite')+'?mode=ro',uri=True) as db:
 out['quick_check']=db.execute('PRAGMA quick_check').fetchone()[0]
 out['pending']={t:db.execute('SELECT status,count(*) FROM '+t+' GROUP BY status').fetchall() for t in ['withdrawals','a_token_withdrawals','a_token_claims']}
print(json.dumps(out))
