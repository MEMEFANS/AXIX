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
release = 'assets-quantity-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')
payload = json.loads(gzip.decompress(base64.b64decode('__PAYLOAD__')))
files = payload['files']
protected = payload['protected']
order = ['public/js/assets.js', 'public/js/trade-account.js', 'public/js/page-loader.js', 'public/index.html']
assert set(files) == set(order)
assert set(protected) == {'src/server.js', 'src/platform-service.js', 'src/wallet-service.js',
                          'src/a-token-team-service.js', 'src/a-token-income.js',
                          'src/a-token-admin-income.js', '.env'}
backup = root / 'backups' / release
replaced = []
originals = {}
metadata = {}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def guard(expected):
    for name in order:
        if digest((root / name).read_bytes()) != files[name][expected]:
            raise RuntimeError('Production content changed: ' + name)
    for name, sha in protected.items():
        if digest((root / name).read_bytes()) != sha:
            raise RuntimeError('Protected content changed: ' + name)


def service():
    result = subprocess.run(['systemctl', 'show', 'wg-platform', '--property=MainPID,ActiveState,SubState'],
                            check=True, capture_output=True, text=True, timeout=10)
    fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    if fields.get('ActiveState') != 'active' or fields.get('SubState') != 'running':
        raise RuntimeError('Application service is not running')
    return fields


def replace(name, data, suffix):
    target = root / name
    tmp = target.with_name(target.name + '.' + suffix + '-' + release)
    info = metadata[name]
    with tmp.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(tmp, stat.S_IMODE(info.st_mode))
    os.chown(tmp, info.st_uid, info.st_gid)
    os.replace(tmp, target)


try:
    guard('before')
    previous_service = service()
    candidate = {}
    for name in order:
        data = base64.b64decode(files[name]['body'], validate=True)
        if digest(data) != files[name]['after']:
            raise RuntimeError('Candidate content mismatch: ' + name)
        if name.endswith('.js'):
            syntax = subprocess.run(['node', '--input-type=module', '--check'],
                                    input=data, capture_output=True, timeout=10)
            if syntax.returncode:
                raise RuntimeError('Candidate syntax failed: ' + name)
        candidate[name] = data
        originals[name] = (root / name).read_bytes()
        metadata[name] = (root / name).stat()
        if digest(originals[name]) != files[name]['before']:
            raise RuntimeError('Backup content changed: ' + name)
    backup.mkdir(parents=True, mode=0o700)
    stage = backup / 'candidate'
    for name in order:
        path = stage / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(candidate[name])
    with tarfile.open(backup / 'previous.tar.gz', 'w:gz') as archive:
        for name in order:
            archive.add(root / name, arcname=name)
    manifest = {name: {k: v for k, v in files[name].items() if k != 'body'} for name in order}
    (backup / 'source-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    guard('before')
    for name in order:
        replaced.append(name)
        replace(name, candidate[name], 'next')
    guard('after')
    uris = {'/': 'public/index.html',
            '/js/assets.js?v=20261011-aix-quantity': 'public/js/assets.js',
            '/js/trade-account.js?v=32-assets': 'public/js/trade-account.js',
            '/js/page-loader.js?v=5-assets': 'public/js/page-loader.js'}
    checks = []
    for uri, name in uris.items():
        req = urllib.request.Request('http://127.0.0.1:8082' + uri, headers={'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(req, timeout=10) as response:
            sha = digest(response.read())
            if sha != files[name]['after']:
                raise RuntimeError('Origin static content mismatch: ' + uri)
            checks.append({'uri': uri, 'status': response.status, 'sha256': sha})
    current_service = service()
    if current_service['MainPID'] != previous_service['MainPID']:
        raise RuntimeError('Application PID changed during static deployment')
    out = {'deployed': True, 'release': release, 'backup_directory': str(backup),
           'completed_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'files': order, 'protected_sources_unchanged': True, 'env_unchanged': True,
           'service': current_service, 'service_restarted': False,
           'database_accessed': False, 'static': checks}
except Exception as error:
    rollback_errors = []
    for name in reversed(replaced):
        try:
            replace(name, originals[name], 'rollback')
            if digest((root / name).read_bytes()) != files[name]['before']:
                raise RuntimeError('Rollback content mismatch')
        except Exception as rollback_error:
            rollback_errors.append({'file': name, 'error': str(rollback_error)})
    out = {'deployed': False, 'release': release, 'backup_directory': str(backup),
           'error': str(error), 'rolled_back': bool(replaced) and not rollback_errors,
           'rollback_errors': rollback_errors, 'service_restarted': False, 'database_accessed': False}
if backup.exists():
    (backup / 'deployment-result.json').write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(out, ensure_ascii=False, indent=2))
