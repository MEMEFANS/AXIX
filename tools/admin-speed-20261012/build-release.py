import base64, difflib, gzip, hashlib, json, pathlib, subprocess
audit=pathlib.Path(__file__).resolve().parent
app=audit.parents[1]/'resources/app'
preflight=json.loads((audit/'release-preflight.json').read_text(encoding='utf-8'))
manifest={item['file']:item for item in json.loads((audit/'manifest.json').read_text(encoding='utf-8'))}
payload={'files':{},'protected':preflight['protected']}
comparison=[]
for name,item in preflight['files'].items():
    previous=(audit/'before'/name).read_bytes(); current=(app/name).read_bytes()
    assert hashlib.sha256(previous).hexdigest()==manifest[name]['beforeSha256'],name
    assert hashlib.sha256(current).hexdigest()==manifest[name]['afterSha256'],name
    raw=gzip.decompress(base64.b64decode(item['gzip_base64']))
    assert hashlib.sha256(raw).hexdigest()==item['sha256']
    before=previous.decode('utf-8-sig').replace('\r\n','\n')
    after=current.decode('utf-8-sig').replace('\r\n','\n')
    production=raw.decode('utf-8-sig').replace('\r\n','\n')
    old,new=before.splitlines(True),after.splitlines(True)
    groups=list(difflib.SequenceMatcher(None,old,new,autojunk=False).get_grouped_opcodes(3))
    for index,group in enumerate(reversed(groups)):
        context=''.join(old[group[0][1]:group[-1][2]])
        replacement=''.join(new[group[0][3]:group[-1][4]])
        assert context and production.count(context)==1,'Patch context mismatch: '+name+' group '+str(index)
        production=production.replace(context,replacement,1)
    if name=='src/server.js': assert production.count('/api/admin/a-token/settle-daily')==raw.decode().count('/api/admin/a-token/settle-daily'),'Unrelated settlement route must retain production state'
    candidate=production.replace('\n','\r\n').encode() if b'\r\n' in raw else production.encode()
    for folder,data in [('production-before',raw),('candidate',candidate)]:
        target=audit/folder/name; target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(data)
    review=audit/'review'/(name.replace('/','_')+'.diff'); review.parent.mkdir(parents=True,exist_ok=True)
    review.write_text(''.join(difflib.unified_diff(raw.decode().splitlines(True),candidate.decode().splitlines(True),fromfile='before/'+name,tofile='after/'+name)),encoding='utf-8')
    if name.endswith('.js'):
        checked=subprocess.run(['node','--input-type=module','--check'],input=candidate,capture_output=True,timeout=10)
        assert checked.returncode==0,name
    payload['files'][name]={'before':item['sha256'],'after':hashlib.sha256(candidate).hexdigest(),'body':base64.b64encode(candidate).decode()}
    comparison.append({'path':name,'patch_groups':len(groups),'production_equals_local_before':raw.decode('utf-8-sig').replace('\r\n','\n')==before,'candidate_equals_local_after':production==after})
    print(name+': '+str(len(groups))+' guarded groups')
(audit/'release-payload.json').write_text(json.dumps(payload),encoding='utf-8')
(audit/'release-manifest.json').write_text(json.dumps({name:{key:value for key,value in item.items() if key!='body'} for name,item in payload['files'].items()},indent=2),encoding='utf-8')
(audit/'production-comparison.json').write_text(json.dumps(comparison,indent=2),encoding='utf-8')
template=(audit/'deploy-template.py').read_text(encoding='utf-8')
generated=template.replace('__PAYLOAD__',base64.b64encode(gzip.compress(json.dumps(payload).encode())).decode())
compile(generated,'deploy-release.py','exec')
(audit/'deploy-release.py').write_text(generated,encoding='utf-8')
print('Prepared '+str(len(payload['files']))+' files, protecting '+str(len(payload['protected']))+' other files')
