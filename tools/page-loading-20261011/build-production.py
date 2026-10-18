import base64
import difflib
import gzip
import hashlib
import json
import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parent
app = root.parents[1] / 'resources/app'
audit = app / 'tools/page-loading-20261011'
preflight = json.loads((root / 'production-preflight.json').read_text(encoding='utf-8'))
manifest = {item['path']: item for item in json.loads((audit / 'manifest.json').read_text(encoding='utf-8'))}
payload = {'files': {}, 'protected': preflight['protected']}
comparison = []
candidate_root = root / 'production-candidate'
for name, item in preflight['static'].items():
    data = gzip.decompress(base64.b64decode(item['gzip_base64']))
    assert hashlib.sha256(data).hexdigest() == item['sha256']
    path = candidate_root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
for name, item in preflight['files'].items():
    original = gzip.decompress(base64.b64decode(item['gzip_base64']))
    local_before = (audit / 'before' / name.removeprefix('public/')).read_bytes()
    local_after = (app / name).read_bytes()
    assert hashlib.sha256(original).hexdigest() == item['sha256']
    assert hashlib.sha256(local_before).hexdigest() == manifest[name]['beforeSha256'], name
    assert hashlib.sha256(local_after).hexdigest() == manifest[name]['afterSha256'], name
    before = local_before.decode('utf-8').replace('\r\n', '\n')
    after = local_after.decode('utf-8').replace('\r\n', '\n')
    production = original.decode('utf-8').replace('\r\n', '\n')
    baseline_equal = production == before
    old_lines, new_lines = before.splitlines(keepends=True), after.splitlines(keepends=True)
    groups = list(difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False).get_grouped_opcodes(3))
    for index, group in enumerate(reversed(groups)):
        old = ''.join(old_lines[group[0][1]:group[-1][2]])
        new = ''.join(new_lines[group[0][3]:group[-1][4]])
        if not old or production.count(old) != 1:
            raise RuntimeError('Production patch context differs: ' + name + ' group ' + str(index))
        production = production.replace(old, new, 1)
    candidate = production.replace('\n', '\r\n').encode('utf-8') if b'\r\n' in original else production.encode('utf-8')
    for folder, data in [('production-before', original), ('production-candidate', candidate)]:
        path = root / folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    review = root / 'production-review' / (name.replace('/', '_') + '.diff')
    review.parent.mkdir(parents=True, exist_ok=True)
    review.write_text(''.join(difflib.unified_diff(original.decode('utf-8').splitlines(keepends=True), candidate.decode('utf-8').splitlines(keepends=True), fromfile=name + ' before', tofile=name + ' after')), encoding='utf-8')
    payload['files'][name] = {'before': item['sha256'], 'after': hashlib.sha256(candidate).hexdigest(), 'body': base64.b64encode(candidate).decode('ascii')}
    comparison.append({'path': name, 'patch_groups': len(groups), 'production_equals_local_before': baseline_equal, 'candidate_equals_local_after': candidate.decode('utf-8').replace('\r\n', '\n') == after})
    if name.endswith('.js'):
        subprocess.run(['node', '--check', str(candidate_root / name)], check=True, capture_output=True, timeout=10)
    print(name + ': ' + str(len(groups)) + ' patch groups; baseline identical: ' + str(baseline_equal))
for filename, data in [('deploy-payload.json', payload), ('deploy-manifest.json', {name: {k:v for k,v in item.items() if k != 'body'} for name,item in payload['files'].items()}), ('production-comparison.json', comparison)]:
    (root / filename).write_text(json.dumps(data, indent=2), encoding='utf-8')
print('Prepared 22 frontend changes; protected hashes: ' + str(len(payload['protected'])))
