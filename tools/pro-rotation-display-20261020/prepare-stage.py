import base64, hashlib, json, pathlib, shutil, sqlite3, subprocess
root = pathlib.Path('/opt/wg-platform')
stage = pathlib.Path('/root/wg-pro-rotation-display-20261020')
payload = json.loads((stage/'payload.json').read_text(encoding='utf-8-sig'))
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
for name, digest in payload['expected'].items():
    assert sha(root/name) == digest, 'Production changed: ' + name
config = pathlib.Path('/var/lib/wg-platform/pro-reporting-exclusions.json')
assert sha(config) == payload['expectedReporting'], 'Reporting configuration changed'
for side in ['baseline', 'candidate']:
    target = stage/side
    target.mkdir(exist_ok=True)
    shutil.copytree(root/'src', target/'src', dirs_exist_ok=True)
    shutil.copytree(root/'test', target/'test', dirs_exist_ok=True)
    (target/'package.json').write_text('{"type":"module"}')
    if not (target/'node_modules').exists():
        (target/'node_modules').symlink_to(root/'node_modules', target_is_directory=True)
    shutil.copy2(config, target/'pro-reporting-exclusions.json')
for name, content in payload['candidate'].items():
    target = stage/'candidate'/name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(base64.b64decode(content))
for name, content in payload['tests'].items():
    target = stage/'candidate'/'test'/name
    target.write_bytes(base64.b64decode(content))
for side in ['candidate','baseline']:
    target = stage/side/'data'
    target.mkdir(exist_ok=True)
    snapshot_source = pathlib.Path('/var/lib/wg-platform/wg-platform.sqlite') if side == 'candidate' else stage/'candidate/data/wg-platform.sqlite'
    with sqlite3.connect('file:'+str(snapshot_source)+'?mode=ro',uri=True) as source, sqlite3.connect(target/'wg-platform.sqlite') as destination:
        source.backup(destination)
tests = ['a-token-pro-reporting.test.js','a-token-pro-rotation-reporting.test.js','a-token-pro-recipient.test.js','a-token-reconcile.test.js',
         'a-token-team-loading.test.js','a-token-ecosystem.test.js','a-token-income.test.js']
results = {}
for name in payload['candidate']:
    if name.endswith('.js'):
        subprocess.run(['node','--check',str(stage/'candidate'/name)],check=True,capture_output=True)
for name in tests:
    result = subprocess.run(['node','test/'+name],cwd=stage/'candidate',capture_output=True,text=True,timeout=90)
    results[name] = {'passed':result.returncode==0,'tail':(result.stdout+result.stderr)[-900:]}
    if result.returncode:
        (stage/'test-results.json').write_text(json.dumps(results))
        raise RuntimeError(json.dumps({name:results[name]}))
(stage/'test-results.json').write_text(json.dumps(results))
print(json.dumps({'passed':len(results),'tests':{name:item['passed'] for name,item in results.items()}}))
