import pathlib,os,stat,subprocess,sqlite3,json,hashlib,urllib.request,urllib.error,http.cookiejar,time,datetime
R=pathlib.Path('/opt/wg-platform');D=pathlib.Path('/var/lib/wg-platform');B=pathlib.Path('/root/wg-hardening-20261014')
def run(a,timeout=15):
 p=subprocess.run(a,capture_output=True,text=True,timeout=timeout)
 return {'code':p.returncode,'out':p.stdout.strip(),'err':p.stderr.strip()[:700]}
out={'at':datetime.datetime.now().isoformat()}
out['service']=run(['systemctl','show','wg-platform','--property=ActiveState,SubState,MainPID,User,Group,UMask,NoNewPrivileges,PrivateTmp,ProtectSystem,ProtectHome,RestrictSUIDSGID,ReadWritePaths,CapabilityBoundingSet,NRestarts'])
pid=run(['systemctl','show','wg-platform','-p','MainPID','--value'])['out']
out['process']=run(['ps','-p',pid,'-o','user=,group=,comm='])
out['files']={}
for p in [R,R/'src',R/'public',R/'backups',R/'secrets.env',D,D/'.env',D/'wg-platform.sqlite',D/'wg-platform.sqlite-wal',D/'wg-platform.sqlite-shm']:
 if p.exists():
  s=p.stat();out['files'][str(p)]={'mode':oct(stat.S_IMODE(s.st_mode)),'uid':s.st_uid,'gid':s.st_gid}
out['group_world_writable_code']=[]
for root,dirs,files in os.walk(R,followlinks=False):
 for p in [pathlib.Path(root)]+[pathlib.Path(root)/n for n in files]:
  if not p.is_symlink() and stat.S_IMODE(p.stat().st_mode)&0o022:out['group_world_writable_code'].append(str(p))
out['env_sha256']=hashlib.sha256((D/'.env').read_bytes()).hexdigest()
out['code_hashes']={str(p.relative_to(R)):hashlib.sha256(p.read_bytes()).hexdigest() for d in ['src','public'] for p in (R/d).rglob('*') if p.is_file() and p.suffix in ['.js','.html','.css']}
with sqlite3.connect('file:'+str(D/'wg-platform.sqlite')+'?mode=ro',uri=True) as db:
 out['sqlite_quick_check']=db.execute('PRAGMA quick_check').fetchone()[0]
 out['users_count']=db.execute('select count(*) from wallet_users').fetchone()[0]
 meta=json.loads(db.execute("select payload_json from service_settings where setting_key='wallet_meta'").fetchone()[0])
 previous=json.loads((B/'ledger-fingerprint.before.json').read_text())
 out['withdrawal_security_unchanged']=previous['safety']=={k:meta.get(k) for k in previous['safety']}
out['ssh']=run(['/usr/sbin/sshd','-T','-C','user=root,host=axix.cc,addr=119.0.217.129'])
out['ssh']['out']='\n'.join(l for l in out['ssh']['out'].splitlines() if any(l.startswith(k+' ') for k in ['permitrootlogin','passwordauthentication','kbdinteractiveauthentication','authenticationmethods','maxauthtries','logingracetime','pubkeyauthentication']))
out['fail2ban']=run(['fail2ban-client','status','sshd'])
out['fail2ban_rules']=run(['iptables','-S','f2b-sshd'])
out['fail2ban_active']=run(['systemctl','is-enabled','fail2ban'])
out['ufw']=run(['ufw','status','verbose'])
out['nginx']=run(['nginx','-t'])
out['certificate_test']=run(['systemctl','show','wg-hardening-cert-test','-p','ActiveState,SubState,ExecMainStatus,Result'])
out['certificate_log']=run(['journalctl','-u','wg-hardening-cert-test','-n','35','--no-pager'])
out['rollback_timers']=run(['bash','-c',"systemctl list-timers --all --no-pager | grep wg-hardening || true"])
# Use the already-configured credentials internally. Do not output secrets, tokens, or cookies.
env=dict(item.decode().split('=',1) for item in pathlib.Path('/proc/'+pid+'/environ').read_bytes().split(b'\0') if b'=' in item)
node="import {getConfig} from './src/config.js';getConfig();console.log(JSON.stringify({username:process.env.PLATFORM_ADMIN_USERNAME,password:process.env.PLATFORM_ADMIN_PASSWORD,fundsToken:process.env.WALLET_ADMIN_TOKEN}));"
p=subprocess.run(['node','--input-type=module','-e',node],cwd=R,env=env,check=True,capture_output=True,text=True,timeout=10)
creds=json.loads(p.stdout)
opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def request(path,body=None,headers=None,expected=200):
 req=urllib.request.Request('http://127.0.0.1:8082'+path,data=json.dumps(body).encode() if body is not None else None,headers={**({'Content-Type':'application/json'} if body is not None else {}),**(headers or {})})
 try:res=opener.open(req,timeout=12)
 except urllib.error.HTTPError as e:res=e
 with res:raw=res.read();status=res.status
 if status!=expected:raise RuntimeError('Unexpected status '+str(status)+' at '+path)
 return json.loads(raw) if raw.startswith((b'{',b'[')) else None
request('/api/admin/dashboard?view=overview',expected=401)
request('/api/admin/login',{'username':creds['username'],'password':creds['password']},headers={'Origin':'http://127.0.0.1:8082'})
overview=request('/api/admin/dashboard?view=overview')
users=request('/api/admin/users?limit=5&offset=0')
request('/api/wallet/admin/withdrawals',headers={'x-wallet-admin-token':creds['fundsToken']})
out['authenticated_read_checks']={'login':True,'dashboard':True,'user_page':True,'funds_withdrawal_list':True,'anonymous_admin_blocked':True}
request('/api/admin/logout',{},headers={'Origin':'http://127.0.0.1:8082'})
# Check new service logs for permission or database failures, without printing log payloads.
out['runtime_error_counts']={}
log=R/'logs/server.stderr.log'
tail=log.read_bytes()[-80000:].decode(errors='replace')
for needle in ['EACCES','EROFS','SQLITE_CANTOPEN','SQLITE_READONLY']:
 out['runtime_error_counts'][needle]=tail.count(needle)
print(json.dumps(out,ensure_ascii=False))
