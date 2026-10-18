import json
import pathlib
import subprocess

root = pathlib.Path('/opt/wg-platform')
pid = subprocess.run(['systemctl','show','wg-platform','--property=MainPID','--value'],check=True,capture_output=True,text=True,timeout=5).stdout.strip()
assert pid.isdecimal() and int(pid) > 0
# Use the same inherited environment and config loader as the running service.
environment = dict(item.decode().split('=',1) for item in pathlib.Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in item)
code = """import {getConfig} from './src/config.js';
const cfg = getConfig();
const defaults = ['127.0.0.1','localhost','::1'].includes(String(cfg.host || '').toLowerCase());
console.log(JSON.stringify({username:process.env.PLATFORM_ADMIN_USERNAME || (defaults ? 'admin' : ''), password:process.env.PLATFORM_ADMIN_PASSWORD || (defaults ? 'WG-Admin-2026' : ''), fundsToken:process.env.WALLET_ADMIN_TOKEN || ''}));"""
result = subprocess.run(['node','--input-type=module','-e',code],cwd=root,env=environment,check=True,capture_output=True,text=True,timeout=10)
credentials = json.loads(result.stdout)
assert all(isinstance(value,str) and value for value in credentials.values()), 'Admin credentials not configured'
print(json.dumps(credentials))
