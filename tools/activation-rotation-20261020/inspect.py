import hashlib
import json
import pathlib
import sqlite3
import subprocess
import urllib.request

root = pathlib.Path('/opt/wg-platform')
data = pathlib.Path('/var/lib/wg-platform')
config = data / '.env'
keys = ['A_TOKEN_COLLECTION_ADDRESS', 'A_TOKEN_ROTATION_ADDRESS',
        'A_TOKEN_ROTATION_ADDRESSES', 'A_TOKEN_ROTATION_PLAN',
        'A_TOKEN_ROTATION_EVERY', 'A_TOKEN_ROTATION_EVERY_BY_PLAN',
        'A_TOKEN_RECONCILE_EXTRA_ADDRESSES']
parsed = {}
for line in config.read_text().splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        if key.strip() in keys:
            parsed[key.strip()] = value.strip()
pid = subprocess.check_output(['systemctl', 'show', 'wg-platform', '-p', 'MainPID', '--value'], text=True).strip()
environment = dict(item.decode().split('=', 1) for item in (pathlib.Path('/proc') / pid / 'environ').read_bytes().split(b'\0') if b'=' in item)
files = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in
         ['src/a-token-activation-service.js', 'src/a-token-team-service.js', 'src/server.js']}
with urllib.request.urlopen('http://127.0.0.1:8082/api/a-token/plans', timeout=15) as response:
    plans = json.load(response)
with sqlite3.connect('file:' + str(data / 'wg-platform.sqlite') + '?mode=ro', uri=True) as db:
    counts = dict(db.execute("SELECT plan,COUNT(*) FROM a_token_activations WHERE status='confirmed' GROUP BY plan"))
reporting = data / 'pro-reporting-exclusions.json'
source = (root / 'src/a-token-activation-service.js').read_text().splitlines()
relevant = [index for index, line in enumerate(source) if any(term in line for term in
            ['rotationEveryByPlan', 'function getCollectionAddressForPlan', 'extraCollectionAddresses', 'function getPlans'])]
sections = '\n'.join('\n'.join(source[max(0, index - 2):index + 17]) for index in relevant)
print(json.dumps({'config': parsed, 'configSha256': hashlib.sha256(config.read_bytes()).hexdigest(),
                  'serviceOverrides': {key: environment[key] for key in keys if key in environment},
                  'plans': plans, 'confirmedByPlan': counts, 'files': files,
                  'reportingFilePresent': reporting.exists(),
                  'reportingFileSha256': hashlib.sha256(reporting.read_bytes()).hexdigest() if reporting.exists() else None,
                  'rotationSource': sections}, ensure_ascii=False))
