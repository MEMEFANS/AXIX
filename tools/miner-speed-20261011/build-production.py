import base64
import difflib
import gzip
import hashlib
import json
import pathlib

root = pathlib.Path(__file__).resolve().parent
app = root.parents[1] / 'resources/app'
preflight = json.loads((root / 'production-preflight.json').read_text(encoding='utf-8'))
payload = {'files': {}, 'protected': preflight['protected']}
for name, item in preflight['files'].items():
    original = gzip.decompress(base64.b64decode(item['gzip_base64']))
    assert hashlib.sha256(original).hexdigest() == item['sha256']
    before = (root / 'before' / name).read_text(encoding='utf-8')
    after = (app / name).read_text(encoding='utf-8')
    production = original.decode('utf-8').replace('\r\n', '\n')
    before_lines = before.splitlines(keepends=True)
    after_lines = after.splitlines(keepends=True)
    groups = list(difflib.SequenceMatcher(None, before_lines, after_lines, autojunk=False).get_grouped_opcodes(3))
    for index, group in enumerate(reversed(groups)):
        old = ''.join(before_lines[group[0][1]:group[-1][2]])
        new = ''.join(after_lines[group[0][3]:group[-1][4]])
        if not old or production.count(old) != 1:
            raise RuntimeError('Production patch context differs: ' + name + ' group ' + str(index))
        production = production.replace(old, new, 1)
    candidate = production.replace('\n', '\r\n').encode('utf-8') if b'\r\n' in original else production.encode('utf-8')
    for folder, data in [('production-before', original), ('production-candidate', candidate)]:
        file = root / folder / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)
    review = root / 'production-review' / (name.replace('/', '_') + '.diff')
    review.parent.mkdir(parents=True, exist_ok=True)
    review.write_text(''.join(difflib.unified_diff(original.decode('utf-8').splitlines(keepends=True),
                      candidate.decode('utf-8').splitlines(keepends=True), fromfile=name + ' before', tofile=name + ' after')), encoding='utf-8')
    payload['files'][name] = {'before': item['sha256'], 'after': hashlib.sha256(candidate).hexdigest(),
                            'body': base64.b64encode(candidate).decode('ascii')}
    print(name + ': ' + str(len(groups)) + ' patch groups; production baseline equals local: ' + str(original.decode('utf-8').replace('\r\n','\n') == before))
(root / 'deploy-payload.json').write_text(json.dumps(payload, indent=2), encoding='utf-8')
(root / 'deploy-manifest.json').write_text(json.dumps({name: {k:v for k,v in item.items() if k != 'body'}
                                                    for name,item in payload['files'].items()}, indent=2), encoding='utf-8')
print('Minimal production patch prepared; prior production changes retained')
