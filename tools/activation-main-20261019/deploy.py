import pathlib,json,subprocess,urllib.request,shutil,time,re,os
p=pathlib.Path('/var/lib/wg-platform/.env');original=p.read_bytes();text=original.decode()
assert re.search(r'^A_TOKEN_ROTATION_PLAN=2\s*$',text,re.M),'Rotation config changed; inspect again'
new,n=re.subn(r'^A_TOKEN_ROTATION_PLAN=.*$', 'A_TOKEN_ROTATION_PLAN=0',text,flags=re.M);assert n==1
b=p.with_name('.env.bak-activation-main-'+time.strftime('%Y%m%d-%H%M%S'));shutil.copy2(p,b);os.chmod(b,0o600)
def replace(data):
 q=p.with_name('.env.activation-main-next');q.write_bytes(data);shutil.copymode(p,q);st=p.stat();os.chown(q,st.st_uid,st.st_gid);os.replace(q,p)
def verify():
 last=None
 for i in range(25):
  try:
   with urllib.request.urlopen('http://127.0.0.1:8082/api/a-token/plans',timeout=5) as res:d=json.load(res)
   assert d['activationEnabled']
   main=d['collectionAddress'];assert main.lower()=='0xa71e0cfb92643ccf1fadcd45fcfb29b7b39c56e6'
   assert d['collectionAddressByPlan']['2'].lower()==main.lower()
   return d
  except Exception as e:last=e;time.sleep(1)
 raise RuntimeError(str(last))
try:
 assert p.read_bytes()==original
 replace(new.encode())
 subprocess.run(['systemctl','restart','wg-platform'],check=True,timeout=45,capture_output=True)
 d=verify()
 subprocess.run(['systemctl','is-active','--quiet','wg-platform'],check=True)
 print(json.dumps({'deployed':True,'rotationPlan':'0','mainAddress':d['collectionAddress'],'collectionAddressByPlan':d['collectionAddressByPlan'],'backup':str(b),'databaseModified':False}))
except:
 replace(original);subprocess.run(['systemctl','restart','wg-platform'],timeout=45,capture_output=True)
 raise
