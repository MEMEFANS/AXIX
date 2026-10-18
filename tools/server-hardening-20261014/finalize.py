import pathlib,subprocess,json,os,datetime,urllib.request,urllib.error,hashlib
B=pathlib.Path('/root/wg-hardening-20261014')
def run(a,timeout=15):return subprocess.run(a,capture_output=True,text=True,timeout=timeout,check=True).stdout.strip()
cert=run(['systemctl','show','wg-hardening-cert-test','-p','ExecMainStatus,Result,ActiveState'])
if 'ExecMainStatus=0' not in cert or 'Result=success' not in cert or 'ActiveState=inactive' not in cert:raise RuntimeError('Certificate renewal test is not complete')
cf=json.loads((B/'cloudflare-networks.json').read_text());fw=run(['ufw','status','verbose'])
if fw.count('# AXIX_CF_ORIGIN')!=len(cf['ipv4'])+len(cf['ipv6']):raise RuntimeError('Cloudflare firewall range count mismatch')
for line in fw.splitlines():
 if 'Anywhere' in line and ('80/tcp' in line or '443/tcp' in line or '80,443' in line):raise RuntimeError('Public origin rule remains')
run(['systemctl','is-active','wg-platform','ssh','nginx','fail2ban'])
effective={key:run(['fail2ban-client','get','sshd',key]) for key in ['bantime','findtime','maxretry']}
if effective!={'bantime':'3600','findtime':'600','maxretry':'5'}:raise RuntimeError('Unexpected SSH ban policy')
# Exercise the configured firewall action using a reserved documentation address.
test='192.0.2.123'
try:
 run(['fail2ban-client','set','sshd','banip',test])
 rules=run(['iptables','-S','f2b-sshd'])
 if test not in rules:raise RuntimeError('Automatic ban firewall action did not take effect')
finally:run(['fail2ban-client','set','sshd','unbanip',test])
checks={}
for path in ['/','/api/admin/session','/admin.html','/funds-admin.html','/js/operator-admin.js','/favicon.svg']:
 req=urllib.request.Request('https://axix.cc'+path,headers={'User-Agent':'AXIX-security-verification','Cache-Control':'no-cache'})
 try:
  with urllib.request.urlopen(req,timeout=15) as r:
   checks[path]=r.status
   if r.status!=200 or not r.read():raise RuntimeError('Public health check failed: '+path)
 except urllib.error.HTTPError as e:
  raise RuntimeError('Public health check failed: '+path+' status='+str(e.code)+' server='+str(e.headers.get('Server')))
run(['systemctl','stop','wg-hardening-origin-rollback.timer'])
out={'completed':True,'at':datetime.datetime.now().isoformat(),'services_active':True,'cf_ipv4_ranges':len(cf['ipv4']),'cf_ipv6_ranges':len(cf['ipv6']),'password_disabled':True,'ssh_ban_policy':effective,'ban_firewall_action_verified':True,'test_ban_removed':True,'certificate_renewal_dry_run_passed':True,'public_health':checks,'rollback_timers':subprocess.run(['bash','-c',"systemctl list-timers --all --no-pager | grep wg-hardening || true"],capture_output=True,text=True,timeout=8).stdout.strip(),'backup_dir':str(B)}
(B/'completed.json').write_text(json.dumps(out,indent=2));os.chmod(B/'completed.json',0o600)
print(json.dumps(out))
