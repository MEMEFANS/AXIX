import json
import pathlib

audit = pathlib.Path(__file__).resolve().parent
baseline = json.loads((audit/'release-preflight.json').read_text(encoding='utf-8'))
fresh = json.loads((audit/'release-preflight-refresh.json').read_text(encoding='utf-8'))
for name,item in baseline['files'].items():
    assert item['sha256'] == fresh['hashes'].get(name), 'Production source changed: '+name
for name,digest in baseline['protected'].items():
    assert digest == fresh['hashes'].get(name), 'Protected source changed: '+name
assert set(fresh['hashes']) == set(baseline['protected']) | {name for name,item in baseline['files'].items() if item['sha256'] is not None}
baseline.update({key:fresh[key] for key in ['captured_at_utc','service','health']})
(audit/'release-preflight.json').write_text(json.dumps(baseline,indent=2),encoding='utf-8')
print('Fresh production hashes verified:',len(fresh['hashes']))
