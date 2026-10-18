import pathlib,subprocess,json,os
b=pathlib.Path('/root/wg-hardening-20261014')
p=b/'install-fail2ban.sh'
p.write_text('''#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=60 update
apt-get -o DPkg::Lock::Timeout=60 install -y --no-install-recommends fail2ban python3-systemd
''')
os.chmod(p,0o700)
r=subprocess.run(['systemd-run','--unit=wg-hardening-install-ban','--property=Type=oneshot',str(p)],capture_output=True,text=True,check=True)
print(json.dumps({'started':True,'unit':'wg-hardening-install-ban','message':r.stderr.strip()}))
