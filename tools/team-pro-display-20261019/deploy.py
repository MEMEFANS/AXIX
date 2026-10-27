import pathlib,json,hashlib,shutil,os,subprocess,time,sqlite3,urllib.request,urllib.error,http.cookiejar
r=pathlib.Path('/opt/wg-platform');s=pathlib.Path('/tmp/aix-pro-display-20261019');d=pathlib.Path('/var/lib/wg-platform')
expected=json.loads((s/'expected.json').read_text())
files=['src/a-token-team-service.js','src/a-token-admin-api.js','src/server.js']
config=d/'pro-reporting-exclusions.json'
assert not config.exists(),'Reporting configuration already exists'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def guard():
 for f in files:assert sha(r/f)==expected[f],'Production changed: '+f
for t in json.loads((s/'test-results.json').read_text()).values():assert t['passed']
qa=json.loads((s/'production-copy-results.json').read_text());manifest=json.loads((s/'pro-reporting-exclusions.json').read_text())
assert qa['admin']['excludedPro']>0
b=r/'backups'/('pro-display-'+time.strftime('%Y%m%d-%H%M%S'));b.mkdir(mode=0o700)
for f in files:
 q=b/f;q.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(r/f,q)
rollback=b/'rollback.sh';rollback.write_text('#!/bin/sh\nset -eu\ntest -f "'+str(b/'success')+'" && exit 0\nsystemctl stop wg-platform\n'+'\n'.join('cp -p "'+str(b/f)+'" "'+str(r/f)+'"' for f in files)+'\npython3 -c "from pathlib import Path; Path(\''+str(config)+'\').unlink(missing_ok=True)"\nsystemctl start wg-platform\n');rollback.chmod(0o700)
unit='aix-pro-display-rescue-'+time.strftime('%H%M%S')
def run(args):return subprocess.run(args,check=True,capture_output=True,text=True,timeout=60).stdout
run(['systemd-run','--unit='+unit,'--on-active=5m',str(rollback)])
def fingerprint():
 with sqlite3.connect('file:'+str(d/'wg-platform.sqlite')+'?mode=ro',uri=True) as c:
  return {table:hashlib.sha256(repr(c.execute('SELECT * FROM '+table+' ORDER BY 1').fetchall()).encode()).hexdigest() for table in ['wallet_users','a_token_activations','a_token_miners','a_token_team_rewards','a_token_miner_releases']}
def req(path,opener=None,body=None):
 data=json.dumps(body).encode() if body is not None else None
 with (opener or urllib.request.build_opener()).open(urllib.request.Request('http://127.0.0.1:8082'+path,data=data,headers={'Content-Type':'application/json'}),timeout=15) as res:return json.load(res)
try:
 guard();run(['systemctl','stop','wg-platform']);guard();before=fingerprint()
 for f in files:
  p=r/f;q=p.with_name(p.name+'.pro-next');q.write_bytes((s/f).read_bytes());shutil.copymode(p,q);st=p.stat();os.chown(q,st.st_uid,st.st_gid);os.replace(q,p)
 config.write_bytes((s/'pro-reporting-exclusions.json').read_bytes());os.chmod(config,0o644)
 assert fingerprint()==before,'Source ledger changed while switching code'
 run(['systemctl','start','wg-platform'])
 for i in range(30):
  try:plans=req('/api/a-token/plans');break
  except Exception:
   if i==29:raise
   time.sleep(1)
 assert plans['collectionAddressByPlan']['2'].lower()==plans['collectionAddress'].lower()
 pid=run(['systemctl','show','wg-platform','-p','MainPID','--value']).strip()
 env=dict(x.decode().split('=',1) for x in pathlib.Path('/proc/'+pid+'/environ').read_bytes().split(b'\0') if b'=' in x)
 code="import {getConfig} from './src/config.js';getConfig();process.stdout.write(JSON.stringify({username:process.env.PLATFORM_ADMIN_USERNAME,password:process.env.PLATFORM_ADMIN_PASSWORD}));"
 creds=json.loads(subprocess.check_output(['node','--input-type=module','-e',code],cwd=r,env=env,text=True,timeout=15))
 opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
 req('/api/admin/login',opener,creds)
 teams={}
 for root in manifest['viewers']:
  view=req('/api/admin/a-token/team-activations?address='+root,opener)
  assert view['excludedRotationPro']==qa['teams'][root]['excludedPro']
  detail=req('/api/admin/users/'+root+'/detail',opener)
  virtual=qa['teams'][root]['displayPro']+qa['teams'][root]['excludedPro']-qa['teams'][root]['rawPro']
  assert detail['team']['actPro']==detail['statsOverride']['real']['teamPro']+virtual-view['excludedRotationPro']
  teams[root]={'deducted':view['excludedRotationPro'],'rawPro':view['rawTeamPro'],'netRealPro':view['teamPro'],'displayPro':detail['team']['actPro']}
 miners=req('/api/admin/a-token/miners?limit=1',opener)['summary']
 stats=req('/api/admin/a-token/stats',opener)['miners']
 assert miners['excludedPro']==qa['admin']['excludedPro']==stats['excludedPro']
 assert miners['by']['active:pro1500']==miners['rawBy']['active:pro1500']-miners['excludedPro']
 run(['systemctl','is-active','--quiet','wg-platform'])
 result={'deployed':True,'backup':str(b),'teams':teams,'admin':miners,'sourceRecordsUnchangedAtSwitch':True,'rotationDisabled':True,'files':{f:sha(r/f) for f in files}}
 (b/'result.json').write_text(json.dumps(result,indent=2));(b/'success').touch()
 run(['systemctl','stop',unit+'.timer'])
 print(json.dumps(result))
except:
 run([str(rollback)]);run(['systemctl','stop',unit+'.timer']);raise
