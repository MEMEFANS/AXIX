import base64
import difflib
import gzip
import hashlib
import json
import pathlib
import subprocess

audit = pathlib.Path(__file__).resolve().parent
app = audit.parents[1] / 'resources/app'
preflight = json.loads((audit / 'release-preflight.json').read_text(encoding='utf-8'))
manifest = {item['path']:item for item in json.loads((audit / 'manifest.json').read_text(encoding='utf-8'))['files']}
payload = {'files':{}, 'protected':preflight['protected']}
comparison = []
sha = lambda data:hashlib.sha256(data).hexdigest()
for name, remote in preflight['files'].items():
    item = manifest[name]
    local_after = (app / name).read_bytes()
    assert sha(local_after) == item['after_sha256'], 'Local source changed: ' + name
    original = gzip.decompress(base64.b64decode(remote['gzip_base64'])) if remote['sha256'] is not None else None
    if original is None:
        # Production's legacy withdrawal page used inline code; its local external
        # redirect helper was never published. Publishing the redirect is safe.
        assert item['new_file'] or name == 'public/js/withdraw-admin.js', 'Missing production file: ' + name
        candidate = local_after
        baseline_equal, groups = True, []
    else:
        assert not item['new_file'], 'Unexpected existing new file: ' + name
        assert sha(original) == remote['sha256']
        local_before = (audit / 'before' / name).read_bytes()
        assert sha(local_before) == item['before_sha256']
        before = local_before.decode('utf-8').replace('\r\n','\n')
        after = local_after.decode('utf-8').replace('\r\n','\n')
        production = original.decode('utf-8').replace('\r\n','\n')
        baseline_equal = production == before
        if not baseline_equal:
            assert name == 'src/server.js', 'Unreviewed baseline difference: ' + name
            differences = ''.join(difflib.unified_diff(before.splitlines(True), production.splitlines(True)))
            assert '/api/admin/a-token/settle-daily' in differences
            (audit / 'server-baseline-difference.diff').write_text(differences,encoding='utf-8')
        old_lines, new_lines = before.splitlines(True), after.splitlines(True)
        groups = list(difflib.SequenceMatcher(None,old_lines,new_lines,autojunk=False).get_grouped_opcodes(3))
        for group in reversed(groups):
            old = ''.join(old_lines[group[0][1]:group[-1][2]])
            new = ''.join(new_lines[group[0][3]:group[-1][4]])
            assert old and production.count(old) == 1, 'Patch context mismatch: ' + name
            production = production.replace(old,new,1)
        if name == 'src/server.js':
            assert '/api/admin/a-token/settle-daily' not in production
        candidate = production.replace('\n','\r\n').encode('utf-8') if b'\r\n' in original else production.encode('utf-8')
    for directory, data in [('release-before', original), ('release-candidate', candidate)]:
        if data is not None:
            path = audit / directory / name
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_bytes(data)
    review = audit / 'release-review' / (name.replace('/','_') + '.diff')
    review.parent.mkdir(parents=True,exist_ok=True)
    review.write_text(''.join(difflib.unified_diff((original or b'').decode('utf-8').splitlines(True),candidate.decode('utf-8').splitlines(True),fromfile=name+' before',tofile=name+' after')),encoding='utf-8')
    payload['files'][name] = {'before':remote['sha256'],'after':sha(candidate),'body':base64.b64encode(candidate).decode('ascii')}
    comparison.append({'path':name,'new_file':original is None,'patch_groups':len(groups),'production_equals_local_before':baseline_equal,'candidate_equals_local_after':candidate.decode('utf-8').replace('\r\n','\n') == local_after.decode('utf-8').replace('\r\n','\n')})
    if name.endswith('.js'):
        checked = subprocess.run(['node','--input-type=module','--check'],input=candidate,capture_output=True,timeout=10)
        assert checked.returncode == 0, 'Syntax failed: '+name
    print(name + ': ' + str(len(groups)) + ' hunks; baseline equal: ' + str(baseline_equal))
for filename, data in [('release-payload.json',payload),('release-manifest.json',{name:{k:v for k,v in item.items() if k!='body'} for name,item in payload['files'].items()}),('release-comparison.json',comparison)]:
    (audit / filename).write_text(json.dumps(data,indent=2),encoding='utf-8')
print('Protected files:',len(payload['protected']))
print('Service:',preflight['service'].replace('\n','; '))
