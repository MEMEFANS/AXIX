import pathlib,os,subprocess,shutil,json,ipaddress,urllib.request,datetime
networks=json.loads('{"source6":"https://www.cloudflare.com/ips-v6","source4":"https://www.cloudflare.com/ips-v4","ipv6":["2400:cb00::/32","2606:4700::/32","2803:f800::/32","2405:b500::/32","2405:8100::/32","2a06:98c0::/29","2c0f:f248::/32"],"ipv4":["173.245.48.0/20","103.21.244.0/22","103.22.200.0/22","103.31.4.0/22","141.101.64.0/18","108.162.192.0/18","190.93.240.0/20","188.114.96.0/20","197.234.240.0/22","198.41.128.0/17","162.158.0.0/15","104.16.0.0/13","104.24.0.0/14","172.64.0.0/13","131.0.72.0/22"],"fetchedAt":"2026-10-14T17:46:54.0346855+08:00"}')
B=pathlib.Path('/root/wg-hardening-20261014');U=pathlib.Path('/etc/ufw')
def run(a,timeout=25):return subprocess.run(a,capture_output=True,text=True,timeout=timeout,check=True)
allnets=[ipaddress.ip_network(n,strict=True) for n in networks['ipv4']+networks['ipv6']]
assert 10<=len(networks['ipv4'])<=30 and 5<=len(networks['ipv6'])<=20
assert all(n.version==4 and 8<=n.prefixlen<=32 for n in allnets[:len(networks['ipv4'])])
assert all(n.version==6 and 20<=n.prefixlen<=64 for n in allnets[len(networks['ipv4']):])
assert len(set(allnets))==len(allnets)
assert all(not n.is_private and not n.is_loopback and not n.is_multicast for n in allnets)
assert not any(ipaddress.ip_address('119.0.217.129') in n for n in allnets if n.version==4)
if (B/'origin-result.json').exists():raise RuntimeError('Origin hardening already exists')
status=run(['ufw','status','verbose']).stdout
if 'Status: active' not in status or '22/tcp' not in status or 'deny (incoming)' not in status:raise RuntimeError('Unexpected firewall baseline')
for n in ['user.rules','user6.rules']:
 dest=B/(n+'.before')
 if dest.exists():raise RuntimeError('Firewall backup already exists')
 shutil.copy2(U/n,dest);os.chmod(dest,0o600)
rollback=B/'rollback-origin.sh'
rollback.write_text('''#!/bin/sh
set -eu
cp /root/wg-hardening-20261014/user.rules.before /etc/ufw/user.rules
cp /root/wg-hardening-20261014/user6.rules.before /etc/ufw/user6.rules
ufw reload
''');os.chmod(rollback,0o700)
run(['systemd-run','--unit=wg-hardening-origin-rollback','--on-active=20m',str(rollback)])
try:
 for n in allnets:
  run(['ufw','allow','proto','tcp','from',str(n),'to','any','port','80,443','comment','AXIX_CF_ORIGIN'])
 # Add trusted source rules before removing broad public rules. SSH rules are untouched.
 run(['ufw','--force','delete','allow','80/tcp'])
 run(['ufw','--force','delete','allow','443/tcp'])
 after=run(['ufw','status','verbose']).stdout
 if 'AXIX_CF_ORIGIN' not in after or '22/tcp' not in after:raise RuntimeError('Firewall rule verification failed')
 health={}
 for p in ['/','/api/admin/session','/admin.html','/funds-admin.html','/favicon.svg']:
  request=urllib.request.Request('https://axix.cc'+p,headers={'Cache-Control':'no-cache','User-Agent':'AXIX-security-verification'})
  with urllib.request.urlopen(request,timeout=18) as res:
   health[p]={'status':res.status,'cloudflare':res.headers.get('Server'),'body_bytes':len(res.read())}
   if res.status!=200:raise RuntimeError('Public site health failed')
 out={'applied':True,'at':datetime.datetime.now().isoformat(),'ipv4_ranges':len(networks['ipv4']),'ipv6_ranges':len(networks['ipv6']),'ssh_rules_preserved':True,'public_checks':health,'firewall':after,'rollback_timer':'wg-hardening-origin-rollback.timer'}
 (B/'cloudflare-networks.json').write_text(json.dumps(networks,indent=2));os.chmod(B/'cloudflare-networks.json',0o600)
 (B/'origin-result.json').write_text(json.dumps(out,indent=2));os.chmod(B/'origin-result.json',0o600)
 print(json.dumps(out))
except Exception:
 subprocess.run([str(rollback)],capture_output=True,timeout=35)
 raise
