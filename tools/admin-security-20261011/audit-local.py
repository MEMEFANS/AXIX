import datetime
import difflib
import hashlib
import json
import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parent
app = root.parents[1] / 'resources/app'
names = ['src/server.js','src/lottery-service.js','src/admin-security.js','src/funds-admin-api.js','public/admin.html','public/withdraw-admin.html','public/funds-admin.html','public/js/admin-lottery.js','public/js/operator-admin.js','public/js/admin-dialogs.js','public/js/funds-admin.js','public/js/withdraw-admin.js','public/js/support-chat.js','public/js/page-loader.js','public/index.html','public/sw.js','public/styles/funds-admin.css','package.json','test/admin-security.test.js','test/admin-security-browser.test.js','test/social-security.test.js']
scan = json.loads((root / 'production-scan.json').read_text(encoding='utf-8'))
manifest = []
for name in names:
    after = (app / name).read_bytes()
    before_file = root / 'before' / name
    before = before_file.read_bytes() if before_file.is_file() else None
    if before == after:
        continue
    if name.endswith('.js'):
        subprocess.run(['node','--check',str(app / name)], check=True, capture_output=True, timeout=10)
    item = {'path':name, 'before_sha256':hashlib.sha256(before).hexdigest() if before is not None else None, 'after_sha256':hashlib.sha256(after).hexdigest(), 'new_file':before is None}
    if name in scan['files']:
        item['production_scan_sha256'] = scan['files'][name]['sha256']
    manifest.append(item)
    target = root / 'review' / (name.replace('/', '_') + '.diff')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(''.join(difflib.unified_diff((before or b'').decode('utf-8').splitlines(True),after.decode('utf-8').splitlines(True),fromfile=name+' before',tofile=name+' after')), encoding='utf-8')
assert hashlib.sha256((app/'src/wallet-service.js').read_bytes()).hexdigest() == scan['files']['src/wallet-service.js']['sha256']
out = {'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'deployed':False, 'files':manifest, 'wallet_service_unchanged':True}
(root / 'manifest.json').write_text(json.dumps(out,ensure_ascii=False,indent=2), encoding='utf-8')
print('Reviewed ' + str(len(manifest)) + ' changed/new source and test files; all JavaScript parses; wallet service unchanged')
