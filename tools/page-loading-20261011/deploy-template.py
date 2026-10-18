import base64
import datetime
import gzip
import hashlib
import json
import os
import pathlib
import stat
import subprocess
import tarfile
import urllib.request

root = pathlib.Path('/opt/wg-platform')
release = 'page-loading-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')
payload = json.loads(gzip.decompress(base64.b64decode('__PAYLOAD__')))
files, protected = payload['files'], payload['protected']
assert len(files) == 22
assert all(name.startswith('public/') for name in files)
assert set(files) == {'public/index.html'} | {'public/js/' + name + '.js' for name in ['core', 'page-loader', 'portal-shared', 'portfolio', 'staking', 'vaults', 'lottery', 'assets', 'wallet', 'trade-account', 'ai-managed', 'strategy', 'a-token-trade', 'support-chat', 'referrals', 'leaderboard', 'ledger', 'ai', 'hyperliquid-client', 'platform-client', 'trade-chart']}
assert protected['src/wallet-service.js'] == '93c7dca51246d2170ce0c5adb398b38a4af5890ba01f58771c38a767289a4a79'
order = sorted(name for name in files if name != 'public/index.html') + ['public/index.html']
backup = root / 'backups' / release
candidate = backup / 'candidate'
originals, metadata = {}, {}
switched = False


def sha(data):
    return hashlib.sha256(data).hexdigest()


def guard(which):
    for name in order:
        if sha((root / name).read_bytes()) != files[name][which]:
            raise RuntimeError('Production baseline changed: ' + name)
    for name, expected in protected.items():
        if sha((root / name).read_bytes()) != expected:
            raise RuntimeError('Protected source changed: ' + name)


def service():
    output = subprocess.run(['systemctl', 'show', 'wg-platform', '--property=MainPID,ActiveState,SubState'], check=True, capture_output=True, text=True, timeout=8).stdout
    return dict(line.split('=', 1) for line in output.splitlines() if '=' in line)


def replace(name, data, suffix):
    target = root / name
    temp = target.with_name(target.name + '.' + suffix + '-' + release)
    with temp.open('xb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    info = metadata[name]
    os.chmod(temp, stat.S_IMODE(info.st_mode))
    os.chown(temp, info.st_uid, info.st_gid)
    os.replace(temp, target)


try:
    guard('before')
    previous = service()
    if previous.get('ActiveState') != 'active' or previous.get('SubState') != 'running':
        raise RuntimeError('Production service is not running')
    backup.mkdir(parents=True, mode=0o700)
    for name in order:
        data = base64.b64decode(files[name]['body'], validate=True)
        if sha(data) != files[name]['after']:
            raise RuntimeError('Candidate hash mismatch: ' + name)
        path = candidate / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        if name.endswith('.js'):
            check = subprocess.run(['node', '--check', str(path)], capture_output=True, timeout=5)
            if check.returncode:
                raise RuntimeError('Candidate syntax failed: ' + name)
        originals[name] = (root / name).read_bytes()
        metadata[name] = (root / name).stat()
    with tarfile.open(backup / 'previous.tar.gz', 'w:gz') as archive:
        for name in order:
            archive.add(root / name, arcname=name)
    manifest = {name: {k:v for k,v in item.items() if k != 'body'} for name,item in files.items()}
    (backup / 'source-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    (backup / 'protected-manifest.json').write_text(json.dumps(protected, indent=2), encoding='utf-8')
    guard('before')
    switched = True
    for name in order:
        replace(name, (candidate / name).read_bytes(), 'next')
    guard('after')
    static = []
    for uri, name in payload['verify_paths'].items():
        with urllib.request.urlopen('http://127.0.0.1:8082' + uri, timeout=5) as response:
            digest = sha(response.read())
            expected = files[name]['after'] if name in files else protected[name]
            if response.status != 200 or digest != expected:
                raise RuntimeError('Origin content mismatch: ' + uri)
            static.append({'uri': uri, 'status': response.status, 'sha256': digest})
    with urllib.request.urlopen('http://127.0.0.1:8082/api/wallet/session', timeout=5) as response:
        if response.status != 200 or json.load(response).get('authenticated') is not False:
            raise RuntimeError('Application health failed')
    current = service()
    if current != previous:
        raise RuntimeError('Production process changed during static deployment')
    guard('after')
    out = {'deployed': True, 'release': release, 'backup_directory': str(backup), 'completed_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'files': order, 'service': current, 'service_restarted': False, 'protected_sources_unchanged': True, 'env_unchanged': True, 'database_accessed': False, 'database_restored': False, 'static': static}
except Exception as error:
    rollback_errors = []
    if switched:
        try:
            for name in order:
                replace(name, originals[name], 'rollback')
            guard('before')
        except Exception as rollback_error:
            rollback_errors.append(str(rollback_error))
    out = {'deployed': False, 'release': release, 'backup_directory': str(backup), 'error': str(error), 'rolled_back': switched and not rollback_errors, 'rollback_errors': rollback_errors, 'database_accessed': False, 'database_restored': False}
if backup.exists():
    (backup / 'deployment-result.json').write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(out, ensure_ascii=False, indent=2))
