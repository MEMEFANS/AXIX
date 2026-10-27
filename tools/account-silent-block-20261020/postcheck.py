"""Read-only, sanitized verification of the isolated production restriction patch.

Run on the production host after deploy.py. This script never changes files,
sessions, settings, assets, or service state. Its stdout contains only check
results, public target identifiers, hashes, counts, and status flags.
"""
import hashlib
import json
import pathlib
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path('/opt/wg-platform')
DATA = pathlib.Path('/var/lib/wg-platform')
STAGE = pathlib.Path('/root/aix-silent-block-20261020')
BASE = 'https://axix.cc'
TARGETS = {
    '7M2VGLHB': '0x09e324a6e3d626812de3fa39b0c86ebb0cfde780',
    'GP7R29JL': '0xb8a4aa7e03622e01d58f5e4d46d57851d16d38f2',
    'ZSZ9ZS34': '0x9aa09a7ffacdcc3178d19a17b7ab9e48beb11419',
}
FILES = ['src/wallet-service.js', 'src/server.js', 'public/index.html', 'public/js/account-action-guard.js']
SCRIPT = '/js/account-action-guard.js?v=20261020-1'


def safe_error(error):
    # Never print exception strings, response bodies, database values, or command
    # output: an unexpected failure must not turn into a secret-bearing dump.
    item = {'errorType': type(error).__name__}
    if isinstance(error, urllib.error.HTTPError):
        item['status'] = error.code
    return item


def section(callback):
    try:
        return callback()
    except Exception as error:
        return {'ok': False, **safe_error(error)}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_setting(db, name, default):
    row = db.execute('SELECT payload_json FROM service_settings WHERE setting_key=?', (name,)).fetchone()
    return json.loads(row[0]) if row else default


def database_check():
    result = {'readonly': True, 'targets': []}
    uri = (DATA / 'wg-platform.sqlite').as_uri() + '?mode=ro'
    with sqlite3.connect(uri, uri=True, timeout=10) as db:
        db.execute('PRAGMA query_only=ON')
        blocks = read_setting(db, 'wallet_account_blocks', {'wallets': {}}).get('wallets', {})
        frozen = read_setting(db, 'wallet_meta', {}).get('withdrawalFrozen', {})
        result['blockCount'] = len(blocks)
        for code, wallet in TARGETS.items():
            ids = {row[0].lower() for row in db.execute(
                'SELECT wallet FROM a_token_user_ids WHERE user_id=? COLLATE NOCASE', (code,))}
            refs = {row[0].lower() for row in db.execute(
                'SELECT wallet FROM platform_referral_links WHERE code=? COLLATE NOCASE', (code,))}
            sessions = db.execute(
                'SELECT COUNT(*) FROM wallet_sessions WHERE address=? COLLATE NOCASE', (wallet,)).fetchone()[0]
            block = blocks.get(wallet) or {}
            item = {
                'inviteCode': code,
                'wallet': wallet,
                'mappingMatches': ids == refs == {wallet},
                'silent': block.get('silent') is True,
                'sessions': sessions,
                'withdrawalFrozen': bool(frozen.get(wallet)),
            }
            item['ok'] = item['mappingMatches'] and item['silent'] and sessions == 0 and item['withdrawalFrozen']
            result['targets'].append(item)
    result['ok'] = result['blockCount'] >= len(TARGETS) and all(item['ok'] for item in result['targets'])
    return result


def deployment_check(manifest):
    saved = json.loads((STAGE / 'deploy-results.json').read_text(encoding='utf-8-sig'))
    targets = saved.get('targets', [])
    targets_match = (
        len(targets) == len(TARGETS)
        and {(item.get('inviteCode'), item.get('wallet')) for item in targets} == set(TARGETS.items())
        and all(item.get('silent') is True and item.get('challengeStatus') == 204 for item in targets)
    )
    backup_success = False
    backup = pathlib.Path(saved.get('backup', ''))
    try:
        backup.resolve().relative_to((ROOT / 'backups').resolve())
        backup_success = (backup / 'success').read_text().strip() == 'ok'
    except (ValueError, OSError):
        pass
    result = {
        'markedSuccessful': saved.get('ok') is True,
        'backupSuccessMarker': backup_success,
        'targetChecksMatch': targets_match,
        'financialRowsUnchanged': saved.get('financialRowsUnchanged') is True,
        'withdrawalsFrozen': saved.get('withdrawalsFrozen') is True,
        'environmentUnchanged': saved.get('environmentUnchanged') is True,
        'reportedProductionHashesMatch': saved.get('productionFiles') == manifest['candidate'],
        'currentProductionHashesMatch': all(digest(ROOT / name) == manifest['candidate'][name] for name in FILES),
    }
    result['ok'] = all(result.values())
    return result


class SameHostRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        if parsed.scheme != 'https' or parsed.hostname != 'axix.cc':
            raise ValueError('Unexpected public origin')
        return super().redirect_request(request, fp, code, message, headers, newurl)


def public_check(manifest):
    # No cookies, account credentials, session hashes, or authenticated requests.
    opener = urllib.request.build_opener(SameHostRedirects())

    def get(path, timeout=12):
        request = urllib.request.Request(BASE + path, headers={
            'User-Agent': 'AxiX-Readonly-Postcheck/1',
            'Cache-Control': 'no-cache',
        })
        with opener.open(request, timeout=timeout) as response:
            body = response.read(2_000_001)
            if len(body) > 2_000_000:
                raise ValueError('Unexpected response size')
            return response.status, body

    def index():
        status, body = get('/')
        has_script = SCRIPT.encode() in body
        return {'status': status, 'versionedGuardPresent': has_script, 'ok': status == 200 and has_script}

    def guard():
        status, body = get(SCRIPT)
        sha256 = hashlib.sha256(body).hexdigest()
        matches = sha256 == manifest['candidate']['public/js/account-action-guard.js']
        return {'status': status, 'sha256': sha256, 'manifestMatch': matches, 'ok': status == 200 and matches}

    def session():
        status, body = get('/api/wallet/session')
        unauthenticated = json.loads(body).get('authenticated') is False
        return {'status': status, 'unauthenticated': unauthenticated, 'ok': status == 200 and unauthenticated}

    def plans():
        status, body = get('/api/a-token/plans', timeout=45)
        activation_bnb = 'BNB' in json.dumps(json.loads(body))
        return {'status': status, 'activationStillBNB': activation_bnb, 'ok': status == 200 and activation_bnb}

    result = {name: section(callback) for name, callback in [
        ('index', index), ('guard', guard), ('anonymousSession', session), ('plans', plans),
    ]}
    result['ok'] = all(item['ok'] for item in result.values())
    return result


def service_check():
    active = subprocess.run(['systemctl', 'is-active', 'wg-platform'],
                            capture_output=True, text=True, timeout=10)
    restarts = subprocess.run(['systemctl', 'show', 'wg-platform', '--property=NRestarts', '--value'],
                              capture_output=True, text=True, timeout=10)
    state = active.stdout.strip()
    restart_value = restarts.stdout.strip()
    count = int(restart_value) if restarts.returncode == 0 and restart_value.isdigit() else None
    return {
        'state': state if state in ['active', 'inactive', 'failed', 'activating', 'deactivating', 'unknown'] else 'unknown',
        'NRestarts': count,
        'ok': active.returncode == 0 and state == 'active' and count is not None,
    }


def main():
    result = {'readonly': True}
    try:
        manifest = json.loads((STAGE / 'manifest.json').read_text(encoding='utf-8-sig'))
        if set(manifest['candidate']) != set(FILES):
            raise ValueError('Unexpected manifest file set')
    except Exception as error:
        result.update({'ok': False, 'manifest': safe_error(error)})
        print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
        return 1
    result['database'] = section(database_check)
    result['deployment'] = section(lambda: deployment_check(manifest))
    result['publicHttps'] = section(lambda: public_check(manifest))
    result['service'] = section(service_check)
    result['ok'] = all(result[name]['ok'] for name in ['database', 'deployment', 'publicHttps', 'service'])
    print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
