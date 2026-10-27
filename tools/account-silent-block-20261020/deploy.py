"""Install the isolated silent restriction patch and restrict exactly three wallets."""
import hashlib
import contextlib
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path('/opt/wg-platform')
DATA = pathlib.Path('/var/lib/wg-platform')
STAGE = pathlib.Path('/root/aix-silent-block-20261020')
TARGETS = {
    '7M2VGLHB': '0x09e324a6e3d626812de3fa39b0c86ebb0cfde780',
    'GP7R29JL': '0xb8a4aa7e03622e01d58f5e4d46d57851d16d38f2',
    'ZSZ9ZS34': '0x9aa09a7ffacdcc3178d19a17b7ab9e48beb11419',
}
FILES = ['src/wallet-service.js', 'src/server.js', 'public/index.html', 'public/js/account-action-guard.js']
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None

def run(args, timeout=45):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()

def private_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    path.chmod(0o600)

def setting(db, key, default):
    row = db.execute('SELECT payload_json FROM service_settings WHERE setting_key=?', (key,)).fetchone()
    return json.loads(row[0]) if row else default

def save_setting(db, key, value):
    db.execute('INSERT INTO service_settings(setting_key,payload_json,updated_at) VALUES(?,?,?) '
               'ON CONFLICT(setting_key) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at',
               (key, json.dumps(value, ensure_ascii=False), int(time.time() * 1000)))

@contextlib.contextmanager
def connect():
    owner = (DATA / 'wg-platform.sqlite').stat()
    db = sqlite3.connect(DATA / 'wg-platform.sqlite', timeout=15)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    try:
        yield db
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()
        # SQLite files must stay writable by the hardened service account.
        for suffix in ['-wal', '-shm']:
            sidecar = DATA / ('wg-platform.sqlite' + suffix)
            if sidecar.exists():
                os.chown(sidecar, owner.st_uid, owner.st_gid)
                os.chmod(sidecar, owner.st_mode & 0o7777)

def validate_targets(db):
    for code, wallet in TARGETS.items():
        ids = {row[0].lower() for row in db.execute('SELECT wallet FROM a_token_user_ids WHERE user_id=? COLLATE NOCASE', (code,))}
        refs = {row[0].lower() for row in db.execute('SELECT wallet FROM platform_referral_links WHERE code=? COLLATE NOCASE', (code,))}
        assert ids == refs == {wallet}, 'Invite mapping changed: ' + code
        assert db.execute('SELECT COUNT(*) FROM wallet_users WHERE address=? COLLATE NOCASE', (wallet,)).fetchone()[0] == 1
        assert db.execute('SELECT COUNT(*) FROM agent_accounts WHERE wallet_address=? COLLATE NOCASE', (wallet,)).fetchone()[0] == 0, 'Bound agent needs separate review'
        assert db.execute('SELECT COUNT(*) FROM a_token_claims WHERE wallet=? COLLATE NOCASE', (wallet,)).fetchone()[0] == 0, 'Existing on-chain claim needs separate review'

def ledger_fingerprint(db):
    # Target financial rows remain byte-for-byte identical. Only auth rows/settings may change.
    result = {}
    for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        name = row[0]
        if name in ['service_settings', 'wallet_sessions']:
            continue
        columns = {col[1] for col in db.execute('PRAGMA table_info("' + name + '")')}
        identity = sorted(columns & {'wallet', 'address', 'wallet_address', 'from_wallet', 'to_wallet', 'referrer_wallet'})
        if not identity:
            continue
        where = ' OR '.join('lower("' + col + '") IN (?,?,?)' for col in identity)
        records = [tuple(record) for record in db.execute('SELECT * FROM "' + name + '" WHERE ' + where, list(TARGETS.values()) * len(identity))]
        encoded = json.dumps(sorted(records, key=repr), ensure_ascii=False, separators=(',', ':')).encode()
        result[name] = {'count': len(records), 'sha256': hashlib.sha256(encoded).hexdigest()}
    return result

def install(source, destination):
    previous = destination.stat() if destination.exists() else None
    temporary = destination.with_name(destination.name + '.silent-block-next')
    shutil.copyfile(source, temporary)
    os.chmod(temporary, previous.st_mode & 0o7777 if previous else 0o644)
    os.chown(temporary, previous.st_uid if previous else 0, previous.st_gid if previous else 0)
    os.replace(temporary, destination)

def rollback(backup):
    if (backup / 'success').exists():
        return
    run(['systemctl', 'stop', 'wg-platform'])
    try:
        for name in FILES:
            saved = backup / name
            destination = ROOT / name
            if saved.exists():
                install(saved, destination)
            elif name == 'public/js/account-action-guard.js' and destination.exists():
                destination.unlink()
        saved = backup / 'auth-before.private.json'
        if saved.exists():
            old = json.loads(saved.read_text())
            with connect() as db:
                db.execute('BEGIN IMMEDIATE')
                blocks = setting(db, 'wallet_account_blocks', {'wallets': {}})
                meta = setting(db, 'wallet_meta', {})
                frozen = meta.setdefault('withdrawalFrozen', {})
                for wallet in TARGETS.values():
                    if old['blocks'][wallet] is None:
                        blocks['wallets'].pop(wallet, None)
                    else:
                        blocks['wallets'][wallet] = old['blocks'][wallet]
                    if old['frozen'][wallet] is None:
                        frozen.pop(wallet, None)
                    else:
                        frozen[wallet] = old['frozen'][wallet]
                save_setting(db, 'wallet_account_blocks', blocks)
                save_setting(db, 'wallet_meta', meta)
                for record in old['sessions']:
                    db.execute('INSERT OR IGNORE INTO wallet_sessions(token_hash,address,expires_at,payload_json) VALUES(?,?,?,?)',
                               tuple(record[key] for key in ['token_hash', 'address', 'expires_at', 'payload_json']))
    finally:
        run(['systemctl', 'start', 'wg-platform'])

if len(sys.argv) == 3 and sys.argv[1] == '--rollback':
    rollback(pathlib.Path(sys.argv[2]))
    sys.exit(0)

payload = json.loads((STAGE / 'manifest.json').read_text(encoding='utf-8-sig'))
assert set(payload['expected']) == set(FILES)
def guard():
    for name in FILES:
        assert sha(ROOT / name) == payload['expected'][name], 'Production file changed: ' + name
        assert sha(STAGE / 'candidate' / name) == payload['candidate'][name], 'Candidate changed: ' + name

guard()
for name in ['src/wallet-service.js', 'src/server.js', 'public/js/account-action-guard.js']:
    run(['node', '--check', str(STAGE / 'candidate' / name)])
with connect() as db:
    validate_targets(db)
backup = ROOT / 'backups' / ('account-silent-block-' + time.strftime('%Y%m%d-%H%M%S'))
backup.mkdir(mode=0o700)
for name in FILES:
    if (ROOT / name).exists():
        (backup / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, backup / name)
private_json(backup / 'manifest.json', payload)
rescue = 'aix-account-silent-block-rescue-' + time.strftime('%H%M%S')
run(['systemd-run', '--unit=' + rescue, '--on-active=6m', '/usr/bin/python3', str(STAGE / 'deploy.py'), '--rollback', str(backup)])
stopped_at = None
try:
    guard()
    run(['systemctl', 'stop', 'wg-platform'])
    stopped_at = time.monotonic()
    guard()
    env_hash = sha(DATA / '.env')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        validate_targets(db)
        before = ledger_fingerprint(db)
        counts_before = {row[0]: db.execute('SELECT COUNT(*) FROM "' + row[0] + '"').fetchone()[0]
                         for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        blocks = setting(db, 'wallet_account_blocks', {'wallets': {}})
        meta = setting(db, 'wallet_meta', {})
        frozen = meta.setdefault('withdrawalFrozen', {})
        sessions = [dict(row) for row in db.execute('SELECT * FROM wallet_sessions WHERE lower(address) IN (?,?,?)', list(TARGETS.values()))]
        auth_backup = {'blocks': {w: blocks['wallets'].get(w) for w in TARGETS.values()},
                       'frozen': {w: frozen.get(w) for w in TARGETS.values()}, 'sessions': sessions}
        private_json(backup / 'auth-before.private.json', auth_backup)
        now = int(time.time() * 1000)
        for code, wallet in TARGETS.items():
            previous = blocks['wallets'].get(wallet) or {}
            revoked = {item['tokenHash']: item for item in previous.get('revokedSessions', [])}
            for record in sessions:
                if record['address'].lower() == wallet:
                    revoked[record['token_hash']] = {'tokenHash': record['token_hash'], 'expiresAt': record['expires_at']}
            blocks['wallets'][wallet] = {**previous, 'silent': True, 'blockedAt': previous.get('blockedAt', now),
                'reason': 'Administrator requested account restriction 2026-10-20', 'inviteCode': code,
                'revokedSessions': list(revoked.values())}
            frozen.setdefault(wallet, {'reason': 'Account restricted by administrator', 'frozenAt': now, 'frozenBy': 'administrator'})
        def authorize(action, table, column, database, source):
            if action in [sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE] and table not in ['service_settings', 'wallet_sessions']:
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        db.set_authorizer(authorize)
        save_setting(db, 'wallet_account_blocks', blocks)
        save_setting(db, 'wallet_meta', meta)
        deleted = db.execute('DELETE FROM wallet_sessions WHERE lower(address) IN (?,?,?)', list(TARGETS.values())).rowcount
        assert deleted == len(sessions)
        after = ledger_fingerprint(db)
        assert before == after, 'Financial record fingerprint changed'
        for name, count in counts_before.items():
            expected = count - deleted if name == 'wallet_sessions' else count
            assert db.execute('SELECT COUNT(*) FROM "' + name + '"').fetchone()[0] == expected, 'Unexpected row count: ' + name
        db.commit()
    for name in FILES:
        install(STAGE / 'candidate' / name, ROOT / name)
    assert sha(DATA / '.env') == env_hash, 'Environment changed'
    run(['systemctl', 'start', 'wg-platform'])
    checks = []
    for attempt in range(45):
        try:
            with urllib.request.urlopen('http://127.0.0.1:8082/api/wallet/session', timeout=2) as response:
                assert json.load(response)['authenticated'] is False
            break
        except (urllib.error.URLError, TimeoutError):
            time.sleep(1)
    else:
        raise RuntimeError('Service did not recover')
    downtime = round(time.monotonic() - stopped_at, 2)
    for code, wallet in TARGETS.items():
        request = urllib.request.Request('http://127.0.0.1:8082/api/wallet/login-challenge',
            data=json.dumps({'address': wallet}).encode(), headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=8) as response:
            assert response.status == 204 and response.headers.get('X-AxiX-Action') == 'idle' and response.read() == b''
        checks.append({'inviteCode': code, 'wallet': wallet, 'challengeStatus': 204, 'silent': True})
    # The existing plans endpoint counts activation rows and took 11.81s on the
    # unchanged production baseline. Allow that work to finish after restart.
    with urllib.request.urlopen('http://127.0.0.1:8082/api/a-token/plans', timeout=45) as response:
        assert response.status == 200
        plans = json.load(response)
        assert 'BNB' in json.dumps(plans), 'Unexpected activation configuration'
    with urllib.request.urlopen('http://127.0.0.1:8082/', timeout=8) as response:
        assert b'/js/account-action-guard.js?v=20261020-1' in response.read()
    with urllib.request.urlopen('http://127.0.0.1:8082/js/account-action-guard.js?v=20261020-1', timeout=8) as response:
        assert hashlib.sha256(response.read()).hexdigest() == payload['candidate']['public/js/account-action-guard.js']
    assert run(['systemctl', 'is-active', 'wg-platform']) == 'active'
    result = {'ok': True, 'targets': checks, 'revokedSessions': deleted, 'financialRowsUnchanged': before == after,
        'financialFingerprints': after, 'withdrawalsFrozen': True, 'environmentUnchanged': sha(DATA / '.env') == env_hash,
        'productionFiles': {name: sha(ROOT / name) for name in FILES}, 'serviceRecoverySeconds': downtime,
        'activationStillBNB': True, 'backup': str(backup), 'at': time.strftime('%Y-%m-%d %H:%M:%S %z')}
    private_json(backup / 'result.json', result)
    private_json(STAGE / 'deploy-results.json', result)
    (backup / 'success').write_text('ok\n')
    run(['systemctl', 'stop', rescue + '.timer'])
    print(json.dumps(result, ensure_ascii=False))
except Exception:
    rollback(backup)
    raise
