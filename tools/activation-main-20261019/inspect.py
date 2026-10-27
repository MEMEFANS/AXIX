import pathlib,json,subprocess,urllib.request
p=pathlib.Path('/var/lib/wg-platform/.env');keys=['A_TOKEN_COLLECTION_ADDRESS','A_TOKEN_ROTATION_PLAN','A_TOKEN_ROTATION_ADDRESS','A_TOKEN_ROTATION_ADDRESSES']
out={'file':str(p),'config':{}}
for line in p.read_text().splitlines():
 if '=' in line:
  k,v=line.split('=',1)
  if k.strip() in keys:out['config'][k.strip()]=v.strip()
pid=subprocess.check_output(['systemctl','show','wg-platform','-p','MainPID','--value'],text=True).strip()
env=dict(x.decode().split('=',1) for x in pathlib.Path('/proc/'+pid+'/environ').read_bytes().split(b'\0') if b'=' in x)
out['serviceOverrides']={k:env[k] for k in keys if k in env}
with urllib.request.urlopen('http://127.0.0.1:8082/api/a-token/plans',timeout=15) as res:out['plans']=json.load(res)
print(json.dumps(out,ensure_ascii=False))
