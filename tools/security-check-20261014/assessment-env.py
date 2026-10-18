import datetime, json, os, pathlib, subprocess
ROOT=pathlib.Path('/opt/wg-platform')
ZONE=datetime.timezone(datetime.timedelta(hours=8))
def run(args):
    p=subprocess.run(args,capture_output=True,text=True,timeout=10)
    return {'code':p.returncode,'output':p.stdout.strip()[:3000]}
out={'captured_beijing':datetime.datetime.now(ZONE).isoformat(),'readonly':True}
out['service_hardening']=run(['systemctl','show','wg-platform','--property=User,Group,NoNewPrivileges,PrivateTmp,ProtectHome,ProtectSystem,RestrictSUIDSGID,MainPID,CapabilityBoundingSet'])
pid=run(['systemctl','show','wg-platform','--property=MainPID','--value'])['output']
if pid.isdigit():out['process_owner']=run(['ps','-o','user=,group=,comm=','-p',pid])
out['automatic_ssh_ban_service']=run(['systemctl','is-active','fail2ban'])
out['file_access']={}
for name in ['.env','wg-platform.sqlite','wg-platform.sqlite-wal']:
    p=ROOT/name
    if p.exists():
        s=p.stat();out['file_access'][name]={'mode':oct(s.st_mode & 0o777),'uid':s.st_uid,'gid':s.st_gid}
out['admin_auth_flags']={}
for name in ['src/admin-auth.js','src/funds-admin-api.js']:
    src=(ROOT/name).read_text(errors='replace')
    out['admin_auth_flags'][name]={'mentions_totp':any(s in src.lower() for s in ['totp','webauthn','twofactor','two_factor']),'twelve_hour_default':'12 * 60 * 60_000' in src,'static_funds_token_check':'getToken()' in src and "x-wallet-admin-token" in src}
print(json.dumps(out,ensure_ascii=False,separators=(',',':')))
