import hashlib
import json
import pathlib

audit = pathlib.Path(__file__).resolve().parent
app = audit.parents[1] / 'resources/app'
names = ['src/admin-security.js','src/a-token-admin-api.js','src/funds-admin-api.js','src/server.js','public/admin.html','public/funds-admin.html','public/js/operator-admin.js','public/js/funds-admin.js','test/admin-security.test.js','test/admin-security-browser.test.js','package.json']
manifest = []
for name in names:
    target = audit/'before'/name
    assert not target.exists(), 'Baseline already captured: '+name
    target.parent.mkdir(parents=True,exist_ok=True)
    data = (app/name).read_bytes()
    target.write_bytes(data)
    manifest.append({'path':name,'before_sha256':hashlib.sha256(data).hexdigest()})
(audit/'baseline.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print('Captured',len(names),'baseline files')
