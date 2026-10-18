import base64
import datetime
import gzip
import hashlib
import json
import pathlib
import subprocess

root = pathlib.Path('/opt/wg-platform')
out = {'captured_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'files': {}, 'protected': {}}
for name in ['src/a-token-team-service.js', 'src/a-token-api.js', 'public/js/earn.js', 'public/index.html']:
    data = (root / name).read_bytes()
    out['files'][name] = {'sha256': hashlib.sha256(data).hexdigest(),
                          'gzip_base64': base64.b64encode(gzip.compress(data)).decode('ascii')}
for name in ['src/server.js', 'src/database.js', 'src/wallet-service.js', 'src/platform-service.js',
             'src/a-token-service.js', 'src/a-token-income.js', 'src/a-token-admin-income.js',
             'src/a-token-ledger.js', 'src/a-token-revenue-service.js', 'public/js/assets.js',
             'public/js/trade-account.js', 'public/js/page-loader.js', '.env']:
    out['protected'][name] = hashlib.sha256((root / name).read_bytes()).hexdigest()
out['service'] = subprocess.run(['systemctl', 'show', 'wg-platform', '--property=MainPID,ActiveState,SubState'],
                                check=True, capture_output=True, text=True, timeout=10).stdout
print(json.dumps(out, ensure_ascii=False))
