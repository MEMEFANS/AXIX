"""Publish the isolated BNB reporting candidate; never write production ledgers."""
import base64
import hashlib
import http.cookiejar
import json
import os
import pathlib
import shutil
import subprocess
import time
import urllib.request

root = pathlib.Path('/opt/wg-platform')
stage = pathlib.Path('/root/wg-pro-rotation-display-20261020')
data = pathlib.Path('/var/lib/wg-platform')
config = data / 'pro-reporting-exclusions.json'
payload = json.loads((stage / 'payload.json').read_text(encoding='utf-8-sig'))
files = list(payload['candidate'])
assert set(files) == {'src/a-token-activation-service.js', 'src/a-token-team-service.js',
                      'src/database.js', 'src/server.js', 'public/js/operator-admin.js', 'public/admin.html'}
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()


def run(args, timeout=30, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout, **kwargs).stdout


def guard():
    for name in files:
        assert sha(root / name) == payload['expected'][name], 'Production changed: ' + name
        expected_candidate = hashlib.sha256(base64.b64decode(payload['candidate'][name])).hexdigest()
        assert sha(stage / 'candidate' / name) == expected_candidate, 'Candidate changed: ' + name
    assert sha(config) == payload['expectedReporting'], 'Reporting configuration changed'


def request(path, opener=None, body=None, timeout=15):
    encoded = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request('http://127.0.0.1:8082' + path, data=encoded,
                                 headers={'Content-Type': 'application/json'})
    with (opener or urllib.request.build_opener()).open(req, timeout=timeout) as response:
        return json.load(response)


def source_fingerprint():
    # The service is stopped for both calls. Include the entire SQLite file and WAL.
    result = {name: sha(data / name) for name in ['wg-platform.sqlite', '.env']}
    wal = data / 'wg-platform.sqlite-wal'
    # A read-only SQLite connection may create an empty WAL without any frames.
    result['wg-platform.sqlite-wal'] = sha(wal) if wal.exists() and wal.stat().st_size > 32 else None
    return result


def atomic_install(source, destination):
    st = destination.stat()
    temporary = destination.with_name(destination.name + '.pro-rotation-next')
    temporary.write_bytes(source.read_bytes())
    os.chmod(temporary, st.st_mode & 0o7777)
    os.chown(temporary, st.st_uid, st.st_gid)
    os.replace(temporary, destination)


guard()
tests = json.loads((stage / 'test-results.json').read_text())
assert len(tests) == 7 and all(item['passed'] for item in tests.values()), 'Regression tests incomplete'
qa = json.loads((stage / 'production-copy-results.json').read_text())
assert qa['ok'] and all(item['unchanged'] for item in qa['databaseAudits'].values()), 'Copy audit failed'
assert set(qa['teams']) == {'0x31f80338d1effe26fdf48b48aabfdbddd6f177bd',
                           '0x436252b4759eee30066a0d1101911caa7a63ccf2'}
for name in files:
    if name.endswith('.js'):
        run(['node', '--check', str(stage / 'candidate' / name)])

backup = root / 'backups' / ('pro-rotation-display-' + time.strftime('%Y%m%d-%H%M%S'))
backup.mkdir(mode=0o700)
for name in files:
    destination = backup / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(root / name, destination)
    original = (root / name).stat()
    os.chown(destination, original.st_uid, original.st_gid)
shutil.copy2(config, backup / 'pro-reporting-exclusions.json')
original = config.stat()
os.chown(backup / 'pro-reporting-exclusions.json', original.st_uid, original.st_gid)
rollback = backup / 'rollback.sh'
rollback.write_text('#!/bin/sh\nset -eu\ntest -f "' + str(backup / 'success') + '" && exit 0\n'
                    'systemctl stop wg-platform\n'
                    + '\n'.join('cp -p "' + str(backup / name) + '" "' + str(root / name) + '"' for name in files)
                    + '\ncp -p "' + str(backup / 'pro-reporting-exclusions.json') + '" "' + str(config) + '"\n'
                    'systemctl start wg-platform\n')
rollback.chmod(0o700)
unit = 'aix-pro-rotation-display-rescue-' + time.strftime('%H%M%S')
run(['systemd-run', '--unit=' + unit, '--on-active=10m', str(rollback)])

try:
    guard()
    run(['systemctl', 'stop', 'wg-platform'])
    stopped_at = time.time()
    guard()
    before = source_fingerprint()
    # Close the final old-verifier window while no new activation can confirm.
    backfill = json.loads(run(['python3', str(stage / 'backfill.py')], timeout=90))
    manifest = json.loads((stage / 'candidate/pro-reporting-exclusions.json').read_text())
    assert set(manifest['viewers']) == set(qa['teams'])
    assert set(manifest['collectionAddresses']) == {
        '0x1266d38865460cf7d0c06985ac5587a5e85de2c0',
        '0x0c89b9ddc29f3e4ac968a3e02611bd95a2df1361'}
    assert set(json.loads(config.read_text())['transactionHashes']) <= set(manifest['transactionHashes'])
    for name in files:
        atomic_install(stage / 'candidate' / name, root / name)
    atomic_install(stage / 'candidate/pro-reporting-exclusions.json', config)
    assert source_fingerprint() == before, 'Database or BNB environment changed during code switch'
    run(['systemctl', 'start', 'wg-platform'])
    health_deadline = time.monotonic() + 35
    while True:
        try:
            plans = request('/api/a-token/plans', timeout=3)
            break
        except Exception:
            if time.monotonic() >= health_deadline:
                raise
            time.sleep(1)
    downtime = round(time.time() - stopped_at, 2)
    assert {item['plan']: item['bnb'] for item in plans['activation']} == {'1': '0.002', '2': '0.05'}
    main = '0xa71e0cfb92643ccf1fadcd45fcfb29b7b39c56e6'
    assert plans['collectionAddress'].lower() == main
    assert plans['collectionAddressByPlan']['1'].lower() == main
    assert plans['collectionAddressByPlan']['2'].lower() in {
        main, '0x1266d38865460cf7d0c06985ac5587a5e85de2c0'}

    pid = run(['systemctl', 'show', 'wg-platform', '-p', 'MainPID', '--value']).strip()
    environment = dict(item.decode().split('=', 1) for item in
                       pathlib.Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in item)
    code = """import {getConfig} from './src/config.js';getConfig();
process.stdout.write(JSON.stringify({credentials:{username:process.env.PLATFORM_ADMIN_USERNAME,password:process.env.PLATFORM_ADMIN_PASSWORD},rotation:{plan:process.env.A_TOKEN_ROTATION_PLAN,addresses:process.env.A_TOKEN_ROTATION_ADDRESSES,everyByPlan:process.env.A_TOKEN_ROTATION_EVERY_BY_PLAN}}));"""
    private = json.loads(run(['node', '--input-type=module', '-e', code], cwd=root, env=environment, timeout=15))
    assert private['rotation'] == {'plan': '2', 'addresses': '2:0x1266d38865460cf7d0c06985ac5587a5e85de2c0',
                                    'everyByPlan': '2:2'}, 'BNB rotation settings changed'
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    request('/api/admin/login', opener, private.pop('credentials'))
    teams = {}
    for viewer in manifest['viewers']:
        view = request('/api/admin/a-token/team-activations?address=' + viewer, opener)
        detail = request('/api/admin/users/' + viewer + '/detail', opener)
        reporting = detail['statsOverride']['reporting']
        raw = detail['statsOverride']['real']
        assert reporting['enabled']
        assert view['excludedRotationPro'] >= qa['teams'][viewer]['excludedPro']
        assert reporting['excludedTeamPro'] == view['excludedRotationPro']
        assert raw['teamPro'] == view['rawTeamPro']
        assert raw['teamPro'] - reporting['excludedTeamPro'] == view['teamPro']
        assert detail['team']['realActPro'] == reporting['realTeamPro'] == view['teamPro']
        assert detail['direct']['realActPro'] == reporting['realDirectPro'] == view['directPro']
        assert raw['directPro'] - reporting['excludedDirectPro'] == reporting['realDirectPro']
        virtual = qa['teams'][viewer]['newDisplayPro'] - qa['teams'][viewer]['filteredRealPro']
        assert detail['team']['actPro'] == reporting['realTeamPro'] + virtual, 'Display overrides changed'
        teams[viewer] = {'excludedPro': view['excludedRotationPro'], 'rawPro': raw['teamPro'],
                         'reportedRealPro': detail['team']['realActPro'], 'displayPro': detail['team']['actPro'],
                         'directRealPro': detail['direct']['realActPro']}
    miners = request('/api/admin/a-token/miners?limit=1', opener)['summary']
    stats = request('/api/admin/a-token/stats', opener)['miners']
    assert miners['excludedPro'] == stats['excludedPro'] >= qa['admin']['candidate']['excludedPro']
    assert miners['total'] == miners['rawTotal'] - miners['excludedPro']
    assert miners['by']['active:pro1500'] == miners['rawBy']['active:pro1500'] - miners['excludedPro']
    run(['systemctl', 'is-active', '--quiet', 'wg-platform'])
    assert sha(data / '.env') == before['.env']
    result = {'deployed': True, 'backup': str(backup), 'teams': teams, 'admin': miners,
              'backfill': backfill, 'databaseAndEnvUnchangedAtSwitch': True, 'bnbActivationPreserved': True,
              'rotation': private['rotation'], 'serviceRestartSeconds': downtime,
              'files': {name: sha(root / name) for name in files}, 'reportingConfigSha256': sha(config)}
    (backup / 'result.json').write_text(json.dumps(result, indent=2))
    (stage / 'deploy-results.json').write_text(json.dumps(result, indent=2))
    (backup / 'success').touch()
    run(['systemctl', 'stop', unit + '.timer'])
    print(json.dumps(result))
except BaseException:
    run([str(rollback)])
    run(['systemctl', 'stop', unit + '.timer'])
    raise
