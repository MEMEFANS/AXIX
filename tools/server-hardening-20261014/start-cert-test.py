import pathlib,subprocess,json
p=subprocess.run(['systemctl','show','wg-hardening-cert-test','-p','LoadState'],capture_output=True,text=True)
cert=pathlib.Path('/usr/bin/certbot')
if not cert.exists():raise RuntimeError('Certbot command unavailable')
r=subprocess.run(['systemd-run','--unit=wg-hardening-cert-test','--property=Type=oneshot',str(cert),'renew','--dry-run','--cert-name','axix.cc','--no-random-sleep-on-renew'],capture_output=True,text=True,check=True)
print(json.dumps({'started':True,'unit':'wg-hardening-cert-test','dry_run':True}))
