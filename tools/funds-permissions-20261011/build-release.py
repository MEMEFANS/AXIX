import base64
import difflib
import gzip
import hashlib
import json
import pathlib
import subprocess

audit=pathlib.Path(__file__).resolve().parent
app=audit.parents[1]/'resources/app'
preflight=json.loads((audit/'release-preflight.json').read_text(encoding='utf-8'))
manifest={item['path']:item for item in json.loads((audit/'manifest.json').read_text(encoding='utf-8'))['files']}
payload={'files':{},'protected':preflight['protected']}
for name,item in preflight['files'].items():
    local=(app/name).read_bytes();assert hashlib.sha256(local).hexdigest()==manifest[name]['after_sha256']
    before=(audit/'before'/name).read_bytes().decode('utf-8').replace('\r\n','\n')
    after=local.decode('utf-8').replace('\r\n','\n')
    raw=gzip.decompress(base64.b64decode(item['gzip_base64']))
    assert hashlib.sha256(raw).hexdigest()==item['sha256']
    production=raw.decode('utf-8').replace('\r\n','\n')
    if production!=before:
        difference=list(difflib.SequenceMatcher(None,before.splitlines(True),production.splitlines(True),autojunk=False).get_grouped_opcodes(3))
        assert name=='src/server.js' and len(difference)==1
        assert '/api/admin/a-token/settle-daily' in ''.join(difflib.unified_diff(before.splitlines(True),production.splitlines(True)))
    old,new=before.splitlines(True),after.splitlines(True)
    groups=list(difflib.SequenceMatcher(None,old,new,autojunk=False).get_grouped_opcodes(3))
    for group in reversed(groups):
        context=''.join(old[group[0][1]:group[-1][2]])
        replacement=''.join(new[group[0][3]:group[-1][4]])
        assert context and production.count(context)==1,'Patch context mismatch: '+name
        production=production.replace(context,replacement,1)
    if name=='src/server.js':assert '/api/admin/a-token/settle-daily' not in production
    candidate=production.replace('\n','\r\n').encode() if b'\r\n' in raw else production.encode()
    for folder,data in [('production-before',raw),('candidate',candidate)]:
        path=audit/folder/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
    payload['files'][name]={'before':item['sha256'],'after':hashlib.sha256(candidate).hexdigest(),'body':base64.b64encode(candidate).decode()}
    if name.endswith('.js'):
        checked=subprocess.run(['node','--input-type=module','--check'],input=candidate,capture_output=True,timeout=10);assert checked.returncode==0
    print(name+': '+str(len(groups))+' hunks')
(audit/'release-payload.json').write_text(json.dumps(payload),encoding='utf-8')
(audit/'release-manifest.json').write_text(json.dumps({name:{k:v for k,v in item.items() if k!='body'} for name,item in payload['files'].items()},indent=2),encoding='utf-8')
template=(audit.parents[0]/'admin-security-20261011/deploy-template.py').read_text(encoding='utf-8')
template=template.replace("'admin-security-'","'funds-permissions-'").replace('assert len(files) == 17','assert len(files) == 8')
template=template.replace("if sha(data) != files[name]['after']:","if sha(data) != (files[name]['after'] if name in files else protected[name]):")
template=template.replace("'/js/operator-admin.js?v=20261011-security-2'","'/js/operator-admin.js?v=20261011-permissions-1'")
template=template.replace("'/js/funds-admin.js?v=20261011-security-1'","'/js/funds-admin.js?v=20261011-permissions-1'")
template=template.replace("'/js/page-loader.js?v=20261011-pages-security-2'","'/js/page-loader.js?v=20261011-pages-security-2'")
template=template.replace("['/api/admin/test-credits','/api/admin/withdrawals','/api/admin/withdrawal-automation']", "['/api/admin/test-credits','/api/admin/withdrawals','/api/admin/withdrawal-automation'] + ['/api/admin/a-token/'+route for route in ['grant','debit','grant-miner','grant-stake','activations/confirm']]")
template=template.replace("request(operator,'/api/wallet/admin/test-credits',401)","request(operator,'/api/wallet/admin/test-credits',401)\n        for uri in ['/api/wallet/admin/asset-adjustments','/api/wallet/admin/miner-grants']:\n            request(operator,uri,401,body={})\n            request(opener,uri,headers=funds_headers)")
template=template.replace("'legacy_funds_api_denied':True,","'legacy_funds_api_denied':True,'operator_asset_miner_paths_denied':True,'funds_asset_miner_read_access_verified':True,")
template=template.replace("if settings.get('enabled') is not False:","if settings.get('enabled') is not initial_auto_enabled:")
template=template.replace("'automatic_withdrawal_enabled':False", "'automatic_withdrawal_enabled':initial_auto_enabled")
template=template.replace("    if wallet_meta(db)['withdrawalAutomation']['enabled'] is not False:\n        raise RuntimeError('Unexpected automatic withdrawal state; refusing to alter it')", "    initial_auto_enabled = wallet_meta(db)['withdrawalAutomation']['enabled']\n    if not isinstance(initial_auto_enabled,bool):\n        raise RuntimeError('Withdrawal setting is invalid')")
template=template.replace("const {createLotteryService}=await import(uri(stage,'lottery-service.js'));","const {createLotteryService}=await import(uri(root,'lottery-service.js'));\nconst {createATokenAdminApi}=await import(uri(stage,'a-token-admin-api.js'));")
template=template.replace(" const lottery=createLotteryService", " const operator=createATokenAdminApi({send:(res,status,payload)=>Object.assign(res,{status,payload}),readBody:()=>{throw Error('Operator may not mutate funds');}});\n for(const route of ['grant','debit','grant-miner','grant-stake','activations/confirm']){const denied={};await operator.handle({method:'POST',headers:{}},denied,'/api/admin/a-token/'+route,{});assert.equal(denied.status,403);}\n const lottery=createLotteryService")
template=template.replace('__PAYLOAD__',base64.b64encode(gzip.compress(json.dumps(payload).encode())).decode())
compile(template,'deploy-release.py','exec')
(audit/'deploy-release.py').write_text(template,encoding='utf-8')
print('Prepared guarded deployment with '+str(len(payload['protected']))+' protected files')
