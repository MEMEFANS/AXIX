import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import time
import urllib.request

root = pathlib.Path('/opt/wg-platform')
data = pathlib.Path('/var/lib/wg-platform')
config = data / '.env'
stage = pathlib.Path('/root/wg-activation-rotation-20261020')
new_address = '0x1266d38865460cf7d0c06985ac5587a5e85de2c0'
old_address = '0x0c89b9ddc29f3e4ac968a3e02611bd95a2df1361'
main_address = '0xa71e0cfb92643ccf1fadcd45fcfb29b7b39c56e6'
expected_env = '241ce027720f8df0b7ba00476429801c639e4d44f7e783679e65686c52872989'
expected_files = {
    'src/a-token-activation-service.js': '2c14b67cffd33a01ae6d458e23381a2ee8cbf594abda242bf1fbf77088c6e8b7',
    'src/a-token-team-service.js': '9ba40363358b5d08873a12041b3fa4cc273b6c625e339c9fe3db4505bc5a0caa',
    'src/server.js': 'fff7b244fc2194672168ffc3a4689440144085a28abaae23be16772590d58454',
}
reporting = data / 'pro-reporting-exclusions.json'
expected_reporting = '647c30a54a969171d4c469f6f981bdb4e24d8832c4c591ff99fb0119fb5413bf'
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()


def run(args, timeout=45):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()


def plans():
    request = urllib.request.Request('http://127.0.0.1:8082/api/a-token/plans', headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.load(response)


def guard():
    assert sha(config) == expected_env, 'Production environment changed; inspect again'
    for name, digest in expected_files.items():
        assert sha(root / name) == digest, 'Production source changed: ' + name
    assert sha(reporting) == expected_reporting, 'Reporting configuration changed'


def replace(content):
    temporary = config.with_name('.env.activation-rotation-next')
    temporary.write_bytes(content)
    shutil.copymode(config, temporary)
    metadata = config.stat()
    os.chown(temporary, metadata.st_uid, metadata.st_gid)
    os.replace(temporary, config)


guard()
test_result = json.loads((stage / 'check.json').read_text())
assert test_result['passed'] >= 5 and test_result['realNetworkCalls'] == 0 and test_result['productionDatabaseWrites'] == 0
before = plans()
assert [(entry['plan'], entry['bnb']) for entry in before['activation']] == [('1', '0.002'), ('2', '0.05')]
assert before['collectionAddress'].lower() == main_address
assert before['collectionAddressByPlan']['1'].lower() == main_address
assert before['collectionAddressByPlan']['2'].lower() == main_address

original = config.read_bytes()
text = original.decode()
parsed = dict(line.split('=', 1) for line in text.splitlines() if '=' in line and not line.lstrip().startswith('#'))
assert parsed['A_TOKEN_ROTATION_PLAN'].strip() == '0'
assert parsed['A_TOKEN_ROTATION_ADDRESSES'].strip().lower() == '2:' + old_address
assert parsed['A_TOKEN_ROTATION_EVERY_BY_PLAN'].strip() == '2:2'
extras = [value.strip() for value in parsed.get('A_TOKEN_RECONCILE_EXTRA_ADDRESSES', '').split(',') if value.strip()]
if old_address not in {address.lower() for address in extras}:
    extras.append(old_address)
updates = {
    'A_TOKEN_ROTATION_PLAN': '2',
    'A_TOKEN_ROTATION_ADDRESSES': '2:' + new_address,
    'A_TOKEN_RECONCILE_EXTRA_ADDRESSES': ','.join(extras),
}
for key, value in updates.items():
    text, count = re.subn(r'^' + re.escape(key) + r'=.*$', key + '=' + value, text, flags=re.M)
    assert count == 1, 'Unexpected configuration key count: ' + key
after_parsed = dict(line.split('=', 1) for line in text.splitlines() if '=' in line and not line.lstrip().startswith('#'))
assert {key: value for key, value in parsed.items() if key not in updates} == {
    key: value for key, value in after_parsed.items() if key not in updates}

backup = data / ('.env.bak-activation-rotation-' + time.strftime('%Y%m%d-%H%M%S'))
shutil.copy2(config, backup)
os.chmod(backup, 0o600)
rescue = stage / 'rollback.py'
success = stage / 'success'
assert not success.exists(), 'This deployment already completed'
rescue.write_text('''import os,pathlib,shutil,subprocess
p=pathlib.Path(%r);b=pathlib.Path(%r);success=pathlib.Path(%r)
if not success.exists():
 q=p.with_name('.env.activation-rotation-rollback');shutil.copy2(b,q);st=p.stat();os.chown(q,st.st_uid,st.st_gid);os.replace(q,p)
 subprocess.run(['systemctl','restart','wg-platform'],check=True,timeout=45)
''' % (str(config), str(backup), str(success)))
os.chmod(rescue, 0o700)
unit = 'aix-activation-rotation-rescue-' + time.strftime('%H%M%S')
run(['systemd-run', '--unit=' + unit, '--on-active=3m', '/usr/bin/python3', str(rescue)])

try:
    guard()
    replace(text.encode())
    run(['systemctl', 'restart', 'wg-platform'])
    last = None
    for attempt in range(25):
        try:
            after = plans()
            assert after['activation'] == before['activation'], 'BNB activation plans changed'
            assert after['miner'] == before['miner'] and after['staking'] == before['staking']
            assert after['activationEnabled'] == before['activationEnabled']
            assert after['withdrawEnabled'] == before['withdrawEnabled']
            assert after['chainId'] == before['chainId'] and after['confirmations'] == before['confirmations']
            assert after['collectionAddress'].lower() == main_address
            assert after['collectionAddressByPlan']['1'].lower() == main_address
            assert after['collectionAddressByPlan']['2'].lower() in {main_address, new_address}
            run(['systemctl', 'is-active', '--quiet', 'wg-platform'])
            break
        except Exception as error:
            last = error
            time.sleep(1)
    else:
        raise RuntimeError(str(last))
    # The exact candidate values above were exercised against the unchanged BNB module.
    for name, digest in expected_files.items():
        assert sha(root / name) == digest, 'Source unexpectedly modified: ' + name
    assert sha(reporting) == expected_reporting
    success.write_text('verified\n')
    run(['systemctl', 'stop', unit + '.timer'])
    result = {'deployed': True, 'paymentMode': 'BNB', 'rotationPlan': '2', 'rotationEveryByPlan': '2:2',
              'rotationAddress': new_address, 'mainAddress': main_address, 'oldAddressRetained': old_address,
              'collectionAddressByPlan': after['collectionAddressByPlan'], 'backup': str(backup),
              'sourceFilesUnchanged': True, 'reportingConfigurationUnchanged': True,
              'databaseWritesByDeployment': 0, 'offlineChecksPassed': test_result['passed'], 'rescueTimerStopped': True}
    (stage / 'deployment-result.json').write_text(json.dumps(result))
    print(json.dumps(result))
except Exception:
    if success.exists():
        success.unlink()
    replace(original)
    run(['systemctl', 'restart', 'wg-platform'])
    run(['systemctl', 'stop', unit + '.timer'])
    raise
