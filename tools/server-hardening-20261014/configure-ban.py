import pathlib,subprocess,json,shutil,os,time
def run(a):return subprocess.run(a,capture_output=True,text=True,timeout=20,check=True)
out={}
out['install_unit']=subprocess.run(['systemctl','show','wg-hardening-install-ban','-p','ActiveState,SubState,ExecMainStatus'],capture_output=True,text=True,timeout=5).stdout
if not pathlib.Path('/usr/bin/fail2ban-client').exists():
 print(json.dumps({'configured':False,'pending_install':True,'status':out}));raise SystemExit(0)
p=pathlib.Path('/etc/fail2ban/jail.d/axix-sshd.local')
if p.exists():raise RuntimeError('Jail already exists; inspect before retry')
p.write_text('''[DEFAULT]
ignoreip = 127.0.0.1/8 ::1
bantime = 1h
findtime = 10m
maxretry = 5
bantime.increment = true
bantime.maxtime = 24h

[sshd]
enabled = true
port = 22
backend = systemd
mode = normal
banaction = iptables-multiport
''');os.chmod(p,0o644)
try:
 checked=run(['fail2ban-client','-t'])
 run(['systemctl','enable','fail2ban'])
 run(['systemctl','restart','fail2ban'])
 for i in range(12):
  try: status=run(['fail2ban-client','status','sshd']).stdout;break
  except Exception:
   if i==11:raise
   time.sleep(0.5)
 out['jail']=status
 out['service']=run(['systemctl','is-active','fail2ban']).stdout.strip()
 out['configured']=True
 print(json.dumps(out))
except Exception:
 p.unlink(missing_ok=True)
 subprocess.run(['systemctl','restart','fail2ban'],capture_output=True)
 raise
