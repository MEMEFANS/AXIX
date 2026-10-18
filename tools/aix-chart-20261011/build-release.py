import base64
import difflib
import gzip
import hashlib
import json
import pathlib
import subprocess

audit = pathlib.Path(__file__).resolve().parent
project = audit.parents[1]
app = project / 'resources/app'
preflight = json.loads((audit / 'release-preflight.json').read_text(encoding='utf-8'))
local = json.loads((audit / 'manifest.json').read_text(encoding='utf-8'))
payload = {'files':{}, 'protected':preflight['protected'], 'verify_paths':{}}
comparison = []
for name, item in preflight['files'].items():
    original = gzip.decompress(base64.b64decode(item['gzip_base64']))
    before_bytes = (audit / 'before' / name).read_bytes()
    after_bytes = (app / name).read_bytes()
    assert hashlib.sha256(original).hexdigest() == item['sha256']
    assert hashlib.sha256(before_bytes).hexdigest() == local['runtimeFiles'][name]['beforeSha256'], name
    assert hashlib.sha256(after_bytes).hexdigest() == local['runtimeFiles'][name]['afterSha256'], name
    before = before_bytes.decode('utf-8').replace('\r\n', '\n')
    after = after_bytes.decode('utf-8').replace('\r\n', '\n')
    production = original.decode('utf-8').replace('\r\n', '\n')
    equal = production == before
    old_lines, new_lines = before.splitlines(keepends=True), after.splitlines(keepends=True)
    groups = list(difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False).get_grouped_opcodes(3))
    for index, group in enumerate(reversed(groups)):
        old = ''.join(old_lines[group[0][1]:group[-1][2]])
        new = ''.join(new_lines[group[0][3]:group[-1][4]])
        if not old or production.count(old) != 1:
            raise RuntimeError('Production patch context differs: ' + name + ' group ' + str(index))
        production = production.replace(old, new, 1)
    candidate = production.replace('\n', '\r\n').encode('utf-8') if b'\r\n' in original else production.encode('utf-8')
    for folder, data in [('production-before', original), ('candidate', candidate)]:
        target = audit / folder / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    review = audit / 'review' / (name.replace('/', '_') + '.diff')
    review.parent.mkdir(parents=True, exist_ok=True)
    review.write_text(''.join(difflib.unified_diff(original.decode('utf-8').splitlines(keepends=True), candidate.decode('utf-8').splitlines(keepends=True), fromfile='before/' + name, tofile='after/' + name)), encoding='utf-8')
    payload['files'][name] = {'before':item['sha256'], 'after':hashlib.sha256(candidate).hexdigest(), 'body':base64.b64encode(candidate).decode('ascii')}
    comparison.append({'path':name, 'patch_groups':len(groups), 'production_equals_local_before':equal, 'candidate_equals_local_after':candidate.decode('utf-8').replace('\r\n', '\n') == after})
    if name.endswith('.js'):
        subprocess.run(['node', '--check', str(audit / 'candidate' / name)], check=True, capture_output=True, timeout=10)
    print(name + ': ' + str(len(groups)) + ' patch groups; baseline identical: ' + str(equal))
payload['verify_paths'] = {
    '/':'public/index.html',
    '/js/page-loader.js?v=20261011-aix-chart-1':'public/js/page-loader.js',
    '/js/a-token-trade.js?v=20261011-aix-chart-1':'public/js/a-token-trade.js',
}
(audit / 'release-payload.json').write_text(json.dumps(payload, indent=2), encoding='utf-8')
(audit / 'release-manifest.json').write_text(json.dumps({name:{k:v for k,v in item.items() if k != 'body'} for name,item in payload['files'].items()}, indent=2), encoding='utf-8')
(audit / 'production-comparison.json').write_text(json.dumps(comparison, indent=2), encoding='utf-8')
template = (project / 'tools/page-loading-20261011/deploy-template.py').read_text(encoding='utf-8')
template = template.replace("release = 'page-loading-'", "release = 'aix-chart-'")
template = template.replace('assert len(files) == 22', 'assert len(files) == 3')
lines = template.splitlines()
lines = ["assert set(files) == {'public/index.html', 'public/js/page-loader.js', 'public/js/a-token-trade.js'}" if line.startswith('assert set(files) ==') else line for line in lines]
encoded = base64.b64encode(gzip.compress(json.dumps(payload).encode('utf-8'))).decode('ascii')
(audit / 'deploy-release.py').write_text('\n'.join(lines).replace('__PAYLOAD__', encoded) + '\n', encoding='utf-8')
print('Prepared 3 frontend changes; protected hashes: ' + str(len(payload['protected'])))
