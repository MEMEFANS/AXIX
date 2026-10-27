#!/usr/bin/env python3
"""Deploy the reviewed AIX activation slice. Run on the production host as root."""
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.request

ROOT = pathlib.Path('/opt/wg-platform')
DATA = pathlib.Path('/var/lib/wg-platform')
RELEASE = os.environ.get('AIX_RELEASE', 'aix-activation-20261021')
WORK = pathlib.Path('/tmp') / RELEASE
ARCHIVE = WORK / 'candidate.tar.gz'
STAGE = WORK / 'stage'
BACKUP = ROOT / 'backups' / RELEASE
DB_PATH = DATA / 'wg-platform.sqlite'
FILES = [
    'src/a-token-activation-service.js', 'src/a-token-api.js',
    'src/a-token-miner-service.js', 'src/a-token-service.js', 'src/database.js',
    'public/js/earn.js', 'public/js/a-token-trade.js', 'public/js/operator-admin.js',
    'public/index.html', 'public/admin.html', 'public/js/page-loader.js',
]
BASELINE = {
    'src/a-token-activation-service.js': '9b00f763d9da44287d5842f4872f094c256ecfd730b8c0299972cca7b3d2b690',
    'src/a-token-api.js': '776089e420d1a7765e7cf0004abbbea201b110c5fdfd279fdc97da583298eddc',
    'src/a-token-miner-service.js': 'b2439b8f0933a51b32dd4d765c8eae991af87259b9e6f1fb18fe296226ea6f28',
    'src/a-token-service.js': 'adcb4fb717be57e4d2377ec3766170dd45e11e82071ac5d548f13b99ea6dc634',
    'src/database.js': 'a76c5a8adf2af3f2fed92fdb67077d80197fda3f7e387e94a663c48dfdedc1f8',
    'public/js/earn.js': 'dfcc2841c8295959c0dab67c019ff06fd99d5cb817354b0f086f6057427b0307',
    'public/js/a-token-trade.js': 'cc97f76c287d07c6088c875edab5f3a30ed9d5118f70d013d5a4b8ef26e52b82',
    'public/js/operator-admin.js': 'ada8c650106ce3ca2e3951d4d3c4a6de7e940ff39d02dc651da347842e375410',
    'public/index.html': '77efbb3418a007ce5e44f3d5a0e83c8dfcac8160a241052c12af0c3b950cfcb2',
    'public/admin.html': 'e9c808a1c71d050d27f5f1126ace0bd31c054d49f73a924c8cd6612643a68abf',
    'public/js/page-loader.js': 'a116f9c5dd57947041761e7479dd799aec206d4afce53d1e52adcc8e2422eabe',
}


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs)


def service_active():
    return subprocess.run(['systemctl', 'is-active', '--quiet', 'wg-platform']).returncode == 0


def db_connect(path=DB_PATH, readonly=True):
    uri = pathlib.Path(path).as_uri() + ('?mode=ro' if readonly else '')
    return sqlite3.connect(uri, uri=True, timeout=20)


def db_state(path=DB_PATH):
    with db_connect(path, True) as db:
        settings = dict(db.execute('SELECT setting_key,payload_json FROM service_settings '
                                   'WHERE setting_key IN (?,?)',
                                   ('wallet_account_blocks', 'a_token_activation_aix_cutover_v1')))
        counts = dict(db.execute('SELECT status,COUNT(*) FROM a_token_activations GROUP BY status'))
        activation_count = db.execute('SELECT COUNT(*) FROM a_token_activations').fetchone()[0]
        miner_count = db.execute('SELECT COUNT(*) FROM a_token_miners').fetchone()[0]
        pending = db.execute("SELECT COUNT(*) FROM a_token_activations WHERE status='pending' AND tx_hash<>''").fetchone()[0]
        index = db.execute("SELECT sql FROM sqlite_master WHERE name='a_token_activations_tx_unique'").fetchone()
    blocks = settings.get('wallet_account_blocks', '')
    block_obj = json.loads(blocks) if blocks else {}
    wallets = block_obj.get('wallets', {})
    return {
        'settings': settings, 'activationCount': activation_count, 'minerCount': miner_count,
        'activationStatuses': counts, 'pendingBnb': pending,
        'blockCount': len(wallets),
        'silentBlockCount': sum(1 for v in wallets.values() if v.get('silent') is True),
        'partialIndex': bool(index and index[0] and 'WHERE' in index[0].upper()),
    }


def test_migration(snapshot):
    test_path = WORK / 'migration-test.sqlite'
    if test_path.exists():
        test_path.unlink()
    source = sqlite3.connect(f'file:{snapshot}?mode=ro', uri=True, timeout=20)
    target = sqlite3.connect(test_path, timeout=20)
    try:
        source.backup(target)
        before = target.execute('SELECT COUNT(*) FROM a_token_activations').fetchone()[0]
        before_miners = target.execute('SELECT COUNT(*) FROM a_token_miners').fetchone()[0]
        index = target.execute("SELECT sql FROM sqlite_master WHERE name='a_token_activations_tx_unique'").fetchone()
        if not index or not index[0] or 'WHERE' in index[0].upper():
            raise RuntimeError('Production activation index differs from expected pre-migration index')
        target.execute('BEGIN IMMEDIATE')
        target.execute('DROP INDEX a_token_activations_tx_unique')
        target.execute('CREATE UNIQUE INDEX a_token_activations_tx_unique '
                       'ON a_token_activations(tx_hash COLLATE NOCASE) WHERE tx_hash <> \'\'')
        target.commit()
        after = target.execute('SELECT COUNT(*) FROM a_token_activations').fetchone()[0]
        after_miners = target.execute('SELECT COUNT(*) FROM a_token_miners').fetchone()[0]
        if (before, before_miners) != (after, after_miners):
            raise RuntimeError('Index migration test changed activation/miner row counts')
        index_sql = target.execute("SELECT sql FROM sqlite_master WHERE name='a_token_activations_tx_unique'").fetchone()[0]
        if 'WHERE' not in index_sql.upper():
            raise RuntimeError('Partial activation index was not created')
        return {'activationRows': after, 'minerRows': after_miners, 'partialIndex': True}
    finally:
        target.close()
        source.close()


def api_port():
    pid = run(['systemctl', 'show', 'wg-platform', '--property=MainPID', '--value']).stdout.strip()
    env = pathlib.Path(f'/proc/{pid}/environ')
    if env.exists():
        for item in env.read_bytes().split(b'\0'):
            if item.startswith(b'PORT='):
                return int(item[5:])
    envfile = DATA / '.env'
    if envfile.exists():
        for line in envfile.read_text(errors='ignore').splitlines():
            if line.startswith('PORT='):
                return int(line.split('=', 1)[1].split('#', 1)[0].strip().strip('"\''))
    return 8080


def verify_http():
    port = api_port()
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/a-token/plans', timeout=10) as response:
        plans = json.loads(response.read())
    if plans.get('paymentMode') != 'aix_balance' or plans.get('paymentAsset') != 'AIX':
        raise RuntimeError('Public activation API did not switch to AIX balance')
    if plans.get('collectionAddress') != '' or plans.get('collectionAddressByPlan') != {}:
        raise RuntimeError('Public activation API still exposes a BNB collection address')
    by_plan = {str(x.get('plan')): x for x in plans.get('activation', [])}
    if by_plan.get('1', {}).get('aix') != '20' or by_plan.get('2', {}).get('aix') != '400':
        raise RuntimeError('Unexpected AIX activation prices')
    if 'bnb' in by_plan.get('1', {}) or 'bnb' in by_plan.get('2', {}):
        raise RuntimeError('Public activation plan still exposes BNB prices')
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=10) as response:
        html = response.read().decode('utf-8', errors='replace')
    if '20 AIX' not in html or '400 AIX' not in html or 'account-action-guard.js' not in html:
        raise RuntimeError('Public home page is missing AIX rules or production account guard')
    if 'run-aix' in html or '/games/' in html:
        raise RuntimeError('Unexpected unrelated game content in deployed home page')
    return {'port': port, 'paymentMode': plans['paymentMode'], 'prices': ['20 AIX', '400 AIX'],
            'collectionAddresses': 'empty', 'homePage': 'AIX rules present; production guard retained; no game references'}


def install_candidate(manifest):
    for name in FILES:
        dest = ROOT / name
        staged = STAGE / name
        st = dest.stat()
        temp = dest.with_name(dest.name + '.new-' + RELEASE)
        shutil.copyfile(staged, temp)
        os.chmod(temp, st.st_mode)
        os.chown(temp, st.st_uid, st.st_gid)
        os.replace(temp, dest)
    if any(sha(ROOT / name) != manifest[name] for name in FILES):
        raise RuntimeError('Installed file checksum verification failed')


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Must run as root')
    if not service_active():
        raise RuntimeError('wg-platform is not active; aborting')
    if not ARCHIVE.is_file():
        raise RuntimeError('Candidate archive missing')
    if BACKUP.exists():
        raise RuntimeError('Release backup already exists; choose a unique release identifier')
    STAGE.mkdir(parents=True, exist_ok=True)
    with tarfile.open(ARCHIVE, 'r:gz') as archive:
        for member in archive.getmembers():
            if member.name.startswith('/') or '..' in pathlib.PurePosixPath(member.name).parts:
                raise RuntimeError('Unsafe candidate archive path')
        archive.extractall(STAGE)
    manifest = json.loads((STAGE / 'manifest.json').read_text())['files']
    if set(manifest) != set(FILES):
        raise RuntimeError('Candidate manifest file set differs from reviewed scope')
    for name in FILES:
        path = STAGE / name
        if not path.is_file() or sha(path) != manifest[name]:
            raise RuntimeError(f'Candidate checksum failed: {name}')
        if name.endswith('.js'):
            run(['node', '--check', str(path)])

    current = {name: sha(ROOT / name) for name in FILES}
    if current != BASELINE:
        changed = [name for name in FILES if current.get(name) != BASELINE[name]]
        raise RuntimeError('Production source drift detected; no files changed: ' + ','.join(changed))
    before = db_state()
    if before['partialIndex']:
        raise RuntimeError('Production activation index already migrated; review before proceeding')
    env_path = DATA / '.env'
    env_hash = sha(env_path) if env_path.exists() else None
    reporting_candidates = [DATA / 'pro-reporting-exclusions.json', ROOT / 'pro-reporting-exclusions.json']
    reporting_path = next((p for p in reporting_candidates if p.is_file()), None)
    reporting_hash = sha(reporting_path) if reporting_path else None
    if before['blockCount'] != 122 or before['silentBlockCount'] != 3:
        raise RuntimeError('Production account block settings drifted; aborting')
    if before['settings'].get('a_token_activation_aix_cutover_v1') is not None:
        raise RuntimeError('AIX activation cutover already exists; aborting')
    if '--preflight-only' in sys.argv:
        print(json.dumps({'preflight': True, 'release': RELEASE, 'files': FILES,
                          'before': {k: v for k, v in before.items() if k != 'settings'},
                          'envHash': env_hash, 'proReportingConfigPresent': bool(reporting_path),
                          'productionSourceMatches': True}, separators=(',', ':')))
        return

    BACKUP.mkdir(parents=True, exist_ok=True)
    snapshot = BACKUP / 'production-pre-migration.sqlite'
    source = db_connect(DB_PATH, True)
    target = sqlite3.connect(snapshot)
    try:
        source.backup(target)
        target.commit()
    finally:
        target.close()
        source.close()
    os.chmod(snapshot, 0o600)
    migration = test_migration(snapshot)

    with tarfile.open(BACKUP / 'previous-code.tar.gz', 'w:gz') as archive:
        for name in FILES:
            archive.add(ROOT / name, arcname=name, recursive=False)
    (BACKUP / 'candidate-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (BACKUP / 'preflight.json').write_text(json.dumps({
        'release': RELEASE, 'files': FILES, 'before': {k: v for k, v in before.items() if k != 'settings'},
        'envHash': env_hash, 'reportingHash': reporting_hash,
        'pendingLegacyBnbAtPreflight': before['pendingBnb'], 'migrationTest': migration,
    }, indent=2) + '\n')

    stop_requested = False
    switching = False
    try:
        stop_requested = True
        run(['systemctl', 'stop', 'wg-platform'], timeout=110)
        if service_active():
            raise RuntimeError('wg-platform did not stop')
        switching = True
        install_candidate(manifest)
        run(['systemctl', 'start', 'wg-platform'], timeout=30)
        deadline = time.time() + 45
        while time.time() < deadline and not service_active():
            time.sleep(1)
        if not service_active():
            raise RuntimeError('New service did not become active; candidate and database retained for diagnosis')
        deadline = time.time() + 30
        http_result = None
        last_error = None
        while time.time() < deadline:
            try:
                http_result = verify_http()
                break
            except Exception as exc:
                last_error = str(exc)
                time.sleep(1)
        if http_result is None:
            raise RuntimeError('Post-deploy HTTP verification failed: ' + str(last_error))
        after = db_state()
        if not after['partialIndex']:
            raise RuntimeError('Database activation hash index migration did not complete')
        if after['activationCount'] < before['activationCount'] or after['minerCount'] < before['minerCount']:
            raise RuntimeError('Activation or miner history count decreased')
        if after['blockCount'] != before['blockCount'] or after['silentBlockCount'] != before['silentBlockCount']:
            raise RuntimeError('Production account block settings changed')
        if after['settings'].get('wallet_account_blocks') != before['settings'].get('wallet_account_blocks'):
            raise RuntimeError('Production account block payload changed')
        cutoff_raw = after['settings'].get('a_token_activation_aix_cutover_v1')
        if not cutoff_raw or not cutoff_raw.isdigit():
            raise RuntimeError('Persisted AIX cutover timestamp is missing or invalid')
        if (sha(env_path) if env_path.exists() else None) != env_hash:
            raise RuntimeError('Production .env changed unexpectedly')
        if reporting_path and sha(reporting_path) != reporting_hash:
            raise RuntimeError('Pro historical reporting configuration changed unexpectedly')
        report = {
            'deployed': True, 'release': RELEASE, 'backup': str(BACKUP), 'files': FILES,
            'candidateHashes': manifest, 'preActivationRows': before['activationCount'],
            'postActivationRows': after['activationCount'], 'preMinerRows': before['minerCount'],
            'postMinerRows': after['minerCount'], 'pendingLegacyBnbBefore': before['pendingBnb'],
            'pendingLegacyBnbAfter': after['pendingBnb'], 'cutoverTimestamp': int(cutoff_raw),
            'partialUniqueIndex': True, 'accountBlocksPreserved': True,
            'envUnchanged': True, 'proReportingConfigUnchanged': bool(reporting_path is None or sha(reporting_path) == reporting_hash),
            'migrationTest': migration, 'http': http_result,
        }
        (BACKUP / 'deployment-result.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, separators=(',', ':')))
    except Exception as original_error:
        recovery = {'switchingStarted': switching}
        try:
            if switching:
                # A partial file replacement must never start a mixed runtime.
                # Finish installing the whole reviewed candidate before starting.
                run(['systemctl', 'stop', 'wg-platform'], timeout=110)
                install_candidate(manifest)
                run(['systemctl', 'start', 'wg-platform'], timeout=30)
                recovery['consistentAixCandidateStarted'] = service_active()
            elif stop_requested:
                run(['systemctl', 'start', 'wg-platform'], timeout=30)
                recovery['originalServiceRestarted'] = service_active()
        except Exception as recovery_error:
            recovery['recoveryError'] = str(recovery_error)
        recovery['originalError'] = str(original_error)
        (BACKUP / 'deployment-failure.json').write_text(json.dumps(recovery, indent=2) + '\n')
        # Never restore the old BNB backend or database after switching starts;
        # the old backend ignores cutover and old snapshots can erase AIX rows.
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'deployed': False, 'error': str(error)}, separators=(',', ':')), file=sys.stderr)
        sys.exit(1)
