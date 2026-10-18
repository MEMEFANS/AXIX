import pathlib,os,subprocess,shutil,json,time,sqlite3,hashlib,pwd,stat,urllib.request,datetime
R=pathlib.Path('/opt/wg-platform'); D=pathlib.Path('/var/lib/wg-platform'); B=pathlib.Path('/root/wg-hardening-20261014')
DROP=pathlib.Path('/etc/systemd/system/wg-platform.service.d')
SEC=DROP/'60-security.conf'; DATA=DROP/'20-data-directory.conf'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def run(a,timeout=35):return subprocess.run(a,capture_output=True,text=True,timeout=timeout,check=True)
def fingerprint(dbfile):
 with sqlite3.connect('file:'+str(dbfile)+'?mode=ro',uri=True) as db:
  names=[r[0] for r in db.execute("select name from sqlite_schema where type='table' and name not like 'sqlite_%' order by name")]
  counts={n:db.execute('select count(*) from "'+n+'"').fetchone()[0] for n in names}
  h=hashlib.sha256()
  for row in db.execute('select address,balances_json from wallet_users order by address'):
   h.update(json.dumps(row,separators=(',',':')).encode())
  row=db.execute("select payload_json from service_settings where setting_key='wallet_meta'").fetchone()
  if not row:raise RuntimeError('Missing wallet security settings')
  meta=json.loads(row[0]); safety={k:meta.get(k) for k in ['withdrawalAutomation','withdrawalFrozen']}
  return {'counts':counts,'balance_sha256':h.hexdigest(),'safety':safety}
def http(path):
 with urllib.request.urlopen('http://127.0.0.1:8082'+path,timeout=8) as res:return res.status,res.read()
if SEC.exists() or DATA.exists() or D.exists():raise RuntimeError('Migration target already exists; inspect before retry')
baseline=json.loads((B/'preflight.json').read_text()) if (B/'preflight.json').exists() else None
code_before={str(p.relative_to(R)):sha(p) for d in ['src','public'] for p in (R/d).rglob('*') if p.is_file() and p.suffix in ['.js','.html','.css']}
env_before=sha(R/'.env')
run(['systemctl','is-active','wg-platform'])
try: account=pwd.getpwnam('wg-platform')
except KeyError:
 run(['useradd','--system','--user-group','--home-dir',str(D),'--shell','/usr/sbin/nologin','wg-platform'])
 account=pwd.getpwnam('wg-platform')
uid,gid=account.pw_uid,account.pw_gid
if uid==0:raise RuntimeError('Unsafe service UID')
B.mkdir(mode=0o700,exist_ok=True);os.chmod(B,0o700)
shutil.copy2('/etc/systemd/system/wg-platform.service',B/'wg-platform.service.before')
shutil.copytree(DROP,B/'wg-platform.service.d.before',dirs_exist_ok=True)
rollback=B/'rollback-service.sh'
rollback.write_text('''#!/bin/sh
set -eu
rm -f /etc/systemd/system/wg-platform.service.d/60-security.conf
systemctl daemon-reload
systemctl restart wg-platform
''');os.chmod(rollback,0o700)
run(['systemd-run','--unit=wg-hardening-service-rollback','--on-active=15m',str(rollback)])
started=time.monotonic();stopped=False
try:
 run(['systemctl','stop','wg-platform'],timeout=45);stopped=True
 with sqlite3.connect(R/'wg-platform.sqlite',timeout=15) as db:
  result=db.execute('pragma wal_checkpoint(TRUNCATE)').fetchone()
  if result[0]!=0:raise RuntimeError('Database still in use')
  if db.execute('pragma quick_check').fetchone()[0]!='ok':raise RuntimeError('Database quick_check failed')
 before=fingerprint(R/'wg-platform.sqlite')
 shutil.copy2(R/'wg-platform.sqlite',B/'wg-platform.sqlite.before')
 os.chmod(B/'wg-platform.sqlite.before',0o600)
 for n in ['.env','.state.json','wallet-accounts.json','platform-accounts.json','market-tokens.json','community-links.json']:
  if (R/n).is_file():shutil.copy2(R/n,B/(n+'.before'));os.chmod(B/(n+'.before'),0o600)
 # Record metadata privately. Do not follow symlinks or recursively open backup data.
 metadata=[]
 for root,dirs,files in os.walk(R,followlinks=False):
  for p in [pathlib.Path(root)]+[pathlib.Path(root)/n for n in files]:
   if not p.is_symlink():
    s=p.stat();metadata.append([str(p),stat.S_IMODE(s.st_mode),s.st_uid,s.st_gid])
 (B/'file-metadata.before.json').write_text(json.dumps(metadata));os.chmod(B/'file-metadata.before.json',0o600)
 D.mkdir(mode=0o700);os.chown(D,uid,gid)
 names=['.env','.state.json','.state.json.tmp','wallet-accounts.json','platform-accounts.json','market-tokens.json','community-links.json','ledger-recovery.json','platform-ledger-transaction.json','ledger','state-backups','wg-platform.sqlite','wg-platform.sqlite-wal','wg-platform.sqlite-shm']
 moved=[]
 for n in names:
  p=R/n
  if p.exists():
   if p.is_symlink():raise RuntimeError('Unexpected runtime symlink: '+n)
   p.rename(D/n);moved.append(n)
   p.symlink_to(D/n,target_is_directory=(D/n).is_dir())
 # Old administrative tools use these paths even when WAL/SHM are recreated.
 for n in ['wg-platform.sqlite-wal','wg-platform.sqlite-shm']:
  if not (R/n).is_symlink() and not (R/n).exists():(R/n).symlink_to(D/n)
 for root,dirs,files in os.walk(D,followlinks=False):
  for p in [pathlib.Path(root)]+[pathlib.Path(root)/n for n in files]:
   if p.is_symlink():raise RuntimeError('Unexpected data symlink')
   os.chown(p,uid,gid);os.chmod(p,0o700 if p.is_dir() else 0o600)
 # Code remains root-owned; remove group/other write access everywhere.
 for root,dirs,files in os.walk(R,followlinks=False):
  for p in [pathlib.Path(root)]+[pathlib.Path(root)/n for n in files]:
   if p.is_symlink():continue
   mode=stat.S_IMODE(p.stat().st_mode)
   os.chown(p,0,0);os.chmod(p,mode & ~0o022)
 os.chmod(R,0o755)
 for n in ['backup','backups','data','tools','test']:
  if (R/n).is_dir():os.chmod(R/n,0o700)
 for p in R.iterdir():
  if p.is_symlink() or p.is_dir():continue
  if p.name.startswith(('.env','secrets.env','wg-platform.sqlite')) or p.suffix in ['.gz','.cpuprofile'] or p.name.startswith('.'):
   os.chmod(p,0o600)
 for n in ['logs','public/assets/tokens']:
  p=R/n;p.mkdir(parents=True,exist_ok=True)
  for root,dirs,files in os.walk(p):
   for f in [pathlib.Path(root)]+[pathlib.Path(root)/x for x in files]:
    if f.is_symlink():continue
    os.chown(f,uid,gid);os.chmod(f,(0o755 if f.is_dir() else 0o644) if n.endswith('tokens') else (0o700 if f.is_dir() else 0o600))
 DATA.write_text('[Service]\nEnvironment=WG_DATA_DIR=/var/lib/wg-platform\n');os.chmod(DATA,0o644)
 SEC.write_text('''[Service]
User=wg-platform
Group=wg-platform
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=/var/lib/wg-platform /opt/wg-platform/logs /opt/wg-platform/public/assets/tokens
''');os.chmod(SEC,0o644)
 # Verify canonical and compatibility database paths against the stopped snapshot.
 after=fingerprint(D/'wg-platform.sqlite'); legacy=fingerprint(R/'wg-platform.sqlite')
 if before!=after or before!=legacy:raise RuntimeError('Database changed during relocation')
 if sha(D/'.env')!=env_before:raise RuntimeError('Environment contents changed')
 code_after={str(p.relative_to(R)):sha(p) for d in ['src','public'] for p in (R/d).rglob('*') if p.is_file() and p.suffix in ['.js','.html','.css']}
 if code_before!=code_after:raise RuntimeError('Source changed during migration')
 run(['systemctl','daemon-reload'])
 run(['systemd-analyze','verify','wg-platform.service'],timeout=20)
 run(['systemctl','start','wg-platform']);stopped=False
 checks={}
 for attempt in range(20):
  try:
   for uri in ['/','/api/admin/session','/admin.html','/funds-admin.html','/favicon.svg']:
    status,body=http(uri)
    if status!=200 or not body:raise RuntimeError('Invalid health response')
    checks[uri]=status
   break
  except Exception:
   if attempt==19:raise
   time.sleep(0.7)
 pid=run(['systemctl','show','wg-platform','-p','MainPID','--value']).stdout.strip()
 if pathlib.Path('/proc/'+pid).stat().st_uid!=uid:raise RuntimeError('Service not running as restricted UID')
 # Test permissions as the actual service account, without changing business data.
 probe="""import fs from 'node:fs';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
const p='/var/lib/wg-platform/.hardening-write-probe';fs.writeFileSync(p,'ok',{mode:0o600});fs.unlinkSync(p);
assert.throws(()=>fs.accessSync('/opt/wg-platform/src/server.js',fs.constants.W_OK));
assert.throws(()=>fs.accessSync('/opt/wg-platform',fs.constants.W_OK));
assert.throws(()=>fs.accessSync('/opt/wg-platform/secrets.env',fs.constants.R_OK));
const d=new DatabaseSync('/var/lib/wg-platform/wg-platform.sqlite',{readOnly:true});assert(d.prepare('select count(*) n from wallet_users').get().n>0);d.close();console.log('ok');"""
 run(['runuser','-u','wg-platform','--','node','--input-type=module','-e',probe],timeout=15)
 current=fingerprint(D/'wg-platform.sqlite')
 if before['safety']!=current['safety']:raise RuntimeError('Withdrawal security settings changed')
 run(['systemctl','stop','wg-hardening-service-rollback.timer'])
 public={'completed':True,'at':datetime.datetime.now().isoformat(),'service_user':'wg-platform','uid':uid,'data_dir':str(D),'moved':moved,'all_table_counts_preserved_at_switch':True,'balances_preserved_at_switch':True,'withdrawal_settings_preserved':True,'env_contents_preserved':True,'source_contents_preserved':True,'health':checks,'elapsed_seconds':round(time.monotonic()-started,2),'legacy_sqlite_path_verified':True}
 (B/'service-result.json').write_text(json.dumps(public,indent=2));os.chmod(B/'service-result.json',0o600)
 # Store financial fingerprints privately; stdout contains no balances or credentials.
 (B/'ledger-fingerprint.before.json').write_text(json.dumps(before,indent=2));os.chmod(B/'ledger-fingerprint.before.json',0o600)
 print(json.dumps(public))
except Exception as exc:
 # Keep current data; rollback never restores an older ledger.
 if D.exists() and (D/'wg-platform.sqlite').exists():
  DATA.write_text('[Service]\nEnvironment=WG_DATA_DIR=/var/lib/wg-platform\n')
  for n in names:
   if (D/n).exists() and not (R/n).exists() and not (R/n).is_symlink():(R/n).symlink_to(D/n,target_is_directory=(D/n).is_dir())
 if SEC.exists():SEC.unlink()
 subprocess.run(['systemctl','daemon-reload'],capture_output=True)
 subprocess.run(['systemctl','restart','wg-platform'],capture_output=True,timeout=45)
 print(json.dumps({'completed':False,'rolled_back_service_permissions':True,'error':type(exc).__name__+': '+str(exc)}))
 raise
