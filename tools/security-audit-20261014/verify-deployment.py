import pathlib,shutil,json,subprocess,hashlib,os
R=pathlib.Path('/opt/wg-platform');S=pathlib.Path('/opt/wg-security-20261014');B=pathlib.Path('/root/wg-security-20261014-150610')
names=['platform-service.test.js','market-catalog.test.js','a-token-ecosystem.test.js','a-token-income.test.js','lottery.test.js','admin-security.test.js','a-token-claim-security.test.js','a-token-withdrawal-security.test.js']
out={'tests':names}
for args in [['npm','run','test:claim-security'],['npm','audit','--json']]:
    p=subprocess.run(args,cwd=R,capture_output=True,text=True,timeout=90)
    if p.returncode:raise RuntimeError(p.stderr[-1500:]+p.stdout[-1500:])
    out['audit' if args[1]=='audit' else 'securityTests']=json.loads(p.stdout)['metadata']['vulnerabilities'] if args[1]=='audit' else p.stdout
out['service']=subprocess.check_output(['systemctl','show','wg-platform','-p','ActiveState,SubState,MainPID,NRestarts,User'],text=True)
deploy=json.loads((B/'result.json').read_text())
out['databaseTablesChangedDuringStartup']=[name for name,row in deploy['ledgerBefore'].items() if deploy['ledgerAfterStartup'].get(name)!=row]
out['sourceHashesVerified']=all(hashlib.sha256((R/name).read_bytes()).hexdigest()==expected for name,expected in deploy['newHashes'].items())
log=(R/'logs/server.stderr.log').read_bytes()[-80000:].decode(errors='replace')
out['logTailErrorCounts']={key:log.count(key) for key in ['EACCES','EROFS','SQLITE_CANTOPEN','SQLITE_READONLY']}
out['rescueTimerActive']=subprocess.run(['systemctl','is-active','wg-security-rescue-'+B.name+'.timer'],capture_output=True,text=True).stdout.strip()
(B/'final-verification.json').write_text(json.dumps(out,indent=2))
print(json.dumps(out))

