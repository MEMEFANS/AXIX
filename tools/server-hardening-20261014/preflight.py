import os, pathlib, subprocess, json, datetime, hashlib
R=pathlib.Path('/opt/wg-platform')
def run(args,limit=8000):
    p=subprocess.run(args,capture_output=True,text=True,timeout=25)
    return {'code':p.returncode,'out':p.stdout.strip()[:limit],'err':p.stderr.strip()[:500]}
def meta(p):
    s=p.lstat()
    return {'name':str(p),'mode':oct(s.st_mode&0o7777),'uid':s.st_uid,'gid':s.st_gid,'size':s.st_size,'link':os.readlink(p) if p.is_symlink() else None,'dir':p.is_dir()}
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
out['os']=pathlib.Path('/etc/os-release').read_text()
out['service']=run(['systemctl','show','wg-platform','--property=FragmentPath,DropInPaths,ExecStart,WorkingDirectory,User,Group,EnvironmentFiles,ReadWritePaths,StandardOutput,StandardError,MainPID,ActiveState'])
out['tree']=[meta(p) for p in sorted(R.iterdir())]
out['data_files']=[meta(p) for d in ['data','ledger','logs','state-backups'] if (R/d).exists() for p in list((R/d).iterdir())[:12]]
out['code_hashes']={str(p.relative_to(R)):hashlib.sha256(p.read_bytes()).hexdigest() for d in ['src','public'] for p in (R/d).rglob('*') if p.is_file() and p.suffix in ['.js','.html','.css']}
out['nginx_paths']=run(['bash','-c',"nginx -T 2>/dev/null | grep -E '(^# configuration|listen |server_name |root |alias |acme|real_ip|set_real_ip|access_log|ssl_certificate|proxy_pass)'"],12000)
out['ssh_config']=run(['/usr/sbin/sshd','-T'])
out['ssh_sources']=run(['bash','-c',"grep -nE '^(Include|Match|PermitRootLogin|PasswordAuthentication|AuthenticationMethods|PubkeyAuthentication|AuthorizedKeysFile)' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/* 2>/dev/null"])
out['authorized_keys_meta']=[meta(p) for p in [pathlib.Path('/root/.ssh'),pathlib.Path('/root/.ssh/authorized_keys')] if p.exists()]
out['authorized_keys_fingerprints']=run(['ssh-keygen','-lf','/root/.ssh/authorized_keys'])
out['ufw']=run(['ufw','status','verbose'])
out['ufw_numbered']=run(['ufw','status','numbered'])
out['timers']=run(['systemctl','list-timers','--no-pager'],5000)
out['tools']=run(['bash','-c',"command -v fail2ban-server apt-get at curl getfacl setfacl; dpkg-query -W -f='${Package} ${Version}\n' systemd openssh-server ufw fail2ban 2>/dev/null"])
out['certbot']=run(['bash','-c',"find /etc/letsencrypt/renewal -maxdepth 1 -type f -exec grep -HE '^(authenticator|installer|webroot_path|server|pref_challs)' {} + 2>/dev/null"])
out['disk']=run(['df','-h','/opt','/var/lib'])
out['write_paths']=run(['bash','-c',"grep -nE 'writeFile|mkdir|appendFile|createWriteStream|renameSync|DATA_ROOT' /opt/wg-platform/src/server.js | head -80"])
out['env_sha256']=hashlib.sha256((R/'.env').read_bytes()).hexdigest()
out['env_data_override']=any(l.startswith('WG_DATA_DIR=') for l in (R/'.env').read_text().splitlines())
print(json.dumps(out,ensure_ascii=False))
