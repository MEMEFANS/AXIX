import pathlib,subprocess,os,json,hashlib,sqlite3,urllib.request,urllib.error,datetime
R=pathlib.Path('/opt/wg-platform');D=pathlib.Path('/var/lib/wg-platform')
out={'at':datetime.datetime.now().isoformat(),'business_mutations':False}
def run(a):
 p=subprocess.run(a,capture_output=True,text=True,timeout=20)
 return {'code':p.returncode,'out':p.stdout.strip(),'err':p.stderr.strip()[:300]}
out['hashes']={str(p.relative_to(R)):hashlib.sha256(p.read_bytes()).hexdigest() for p in list((R/'src').glob('*.js'))+[R/'package.json',R/'package-lock.json']}
pid=run(['systemctl','show','wg-platform','-p','MainPID','--value'])['out']
env=dict(v.decode().split('=',1) for v in pathlib.Path('/proc/'+pid+'/environ').read_bytes().split(b'\0') if b'=' in v)
code="""import {getConfig} from './src/config.js';const cfg=getConfig();const e=process.env;console.log(JSON.stringify({claimContractConfigured:Boolean(e.AIX_POOL_CONTRACT_ADDRESS),claimContractAddress:e.AIX_POOL_CONTRACT_ADDRESS||'',claimSignerConfigured:Boolean(e.AIX_POOL_SIGNER_PRIVATE_KEY),claimRpcConfigured:Boolean(e.AIX_POOL_RPC_URL||e.A_TOKEN_RPC_URL),operatorTokenConfigured:Boolean(cfg.operatorToken),fundsTokenConfigured:Boolean(e.WALLET_ADMIN_TOKEN),adminUsernameConfigured:Boolean(e.PLATFORM_ADMIN_USERNAME),adminPasswordConfigured:Boolean(e.PLATFORM_ADMIN_PASSWORD),adminPasswordDefault:e.PLATFORM_ADMIN_PASSWORD==='WG-Admin-2026',trustProxy:cfg.trustProxy}));"""
q=subprocess.run(['node','--input-type=module','-e',code],cwd=R,env=env,capture_output=True,text=True,timeout=15,check=True)
out['config_flags']=json.loads(q.stdout)
out['dependencies']={n:json.loads((R/'node_modules'/n/'package.json').read_text())['version'] for n in ['undici','http-cache-semantics']}
out['service']=run(['systemctl','show','wg-platform','-p','ActiveState,SubState,User,NoNewPrivileges,ProtectSystem'])
out['public_symlinks']=run(['find',str(R/'public'),'-type','l','-printf','%P -> %l\n'])
out['exposed_sensitive_names']=run(['bash','-c',"find /opt/wg-platform/public -type f \\( -name '*.sqlite*' -o -name '.env*' -o -name '*.pem' -o -name '*.key' -o -name '*.map' -o -name '*.tar.gz' \\) -printf '%P\\n'"])
with sqlite3.connect('file:'+str(D/'wg-platform.sqlite')+'?mode=ro',uri=True) as db:
 out['claim_status_counts']=[list(r) for r in db.execute('select status,count(*) from a_token_claims group by status')]
 out['lottery_assigned_status_counts']=[list(r) for r in db.execute('select status,count(*) from assigned_wins group by status')]
 out['audit_counts']={n:db.execute('select count(*) from '+n).fetchone()[0] for n in ['wallet_users','balance_adjustments','social_submissions','lottery_wins']}
out['public_checks']={}
for p in ['/.env','/wg-platform.sqlite','/src/config.js','/api/admin/dashboard?view=overview','/api/wallet/admin/withdrawal-automation','/api/overview','/api/a-token/claim-status','/api/lottery/config','/api/wallet/session']:
 req=urllib.request.Request('https://axix.cc'+p,headers={'User-Agent':'AXIX-security-verification','Cache-Control':'no-cache'})
 try:res=urllib.request.urlopen(req,timeout=15)
 except urllib.error.HTTPError as e:res=e
 with res:
  sample=res.read(256)
  out['public_checks'][p]={'status':res.status,'content_type':res.headers.get('Content-Type'),'cache_control':res.headers.get('Cache-Control'),'cf_cache':res.headers.get('CF-Cache-Status'),'sample_bytes':len(sample)}
print(json.dumps(out,ensure_ascii=False))
