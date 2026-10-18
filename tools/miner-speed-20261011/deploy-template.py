import base64
import datetime
import gzip
import hashlib
import json
import os
import pathlib
import sqlite3
import stat
import subprocess
import tarfile
import time
import urllib.error
import urllib.request

root = pathlib.Path('/opt/wg-platform')
release = 'team-speed-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')
payload = json.loads(gzip.decompress(base64.b64decode('__PAYLOAD__')))
files = payload['files']
protected = payload['protected']
order = ['src/a-token-team-service.js', 'src/a-token-api.js', 'public/js/earn.js', 'public/index.html']
assert set(files) == set(order)
assert set(protected) == {'src/server.js', 'src/database.js', 'src/wallet-service.js', 'src/platform-service.js',
                          'src/a-token-service.js', 'src/a-token-income.js', 'src/a-token-admin-income.js',
                          'src/a-token-ledger.js', 'src/a-token-revenue-service.js', 'public/js/assets.js',
                          'public/js/trade-account.js', 'public/js/page-loader.js', '.env'}
backup = root / 'backups' / release
candidate = backup / 'candidate'
switched = False
stopped = False
originals = {}
metadata = {}


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
    result = subprocess.run(['systemctl', 'show', 'wg-platform', '--property=MainPID,ActiveState,SubState'],
                            capture_output=True, text=True, check=True, timeout=5).stdout
    return dict(line.split('=', 1) for line in result.splitlines() if '=' in line)


def readonly():
    connection = sqlite3.connect('file:' + str(root / 'wg-platform.sqlite') + '?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA query_only=ON')
    return connection


def balances(db):
    return {r['address'].lower(): json.dumps(json.loads(r['balances_json']), sort_keys=True, separators=(',', ':'))
            for r in db.execute('SELECT address,balances_json FROM wallet_users')}


def rewards(db):
    result = {}
    for table in ['a_token_miner_releases', 'a_token_stake_rewards', 'a_token_team_rewards', 'a_token_direct_count_rewards']:
        rows = [list(r) for r in db.execute('SELECT id,amount_units FROM ' + table + ' ORDER BY id')]
        result[table] = {'count': len(rows), 'sha256': sha(json.dumps(rows, separators=(',', ':')).encode())}
    return result


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


probe = r'''
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
const [root,stage,copy] = process.argv.slice(1);
const uri = name => pathToFileURL(path.join(root,'src',name)).href;
const {openDatabase,closeDatabase} = await import(uri('database.js'));
function sourceURL(file,dependencies) {
  let code=fs.readFileSync(file,'utf8');
  for(const name of dependencies)code=code.replaceAll("'./"+name+"'",JSON.stringify(uri(name)));
  code=code.replaceAll("'ethers'",JSON.stringify(pathToFileURL(path.join(root,'node_modules/ethers/lib.esm/index.js')).href));
  return 'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
}
const original=await import(sourceURL(path.join(root,'src/a-token-team-service.js'),['a-token-income.js','a-token-ledger.js']));
const patched=await import(sourceURL(path.join(stage,'src/a-token-team-service.js'),['a-token-income.js','a-token-ledger.js']));
const {createATokenApi}=await import(sourceURL(path.join(stage,'src/a-token-api.js'),['a-token-revenue-service.js']));
try {
  const db=openDatabase(copy);
  const funds=new Map(db.db.prepare('SELECT address,balances_json FROM wallet_users').all().map(r=>[r.address.toLowerCase(),JSON.parse(r.balances_json)]));
  const walletService={database:db,balanceUnits:(wallet,asset)=>BigInt(funds.get(wallet.toLowerCase())?.[asset]||'0')};
  const before=original.createATokenTeamService({database:db,walletService});
  const after=patched.createATokenTeamService({database:db,walletService});
  const wallets=db.db.prepare("SELECT referrer_wallet AS wallet,COUNT(*) AS c FROM platform_referral_links WHERE referrer_wallet IS NOT NULL GROUP BY referrer_wallet ORDER BY c DESC LIMIT 3").all();
  const results=[];
  for(const {wallet} of wallets) {
    let t=performance.now();const old=before.profile(wallet);const oldMs=performance.now()-t;
    t=performance.now();const fresh=after.profile(wallet);const newMs=performance.now()-t;
    assert.deepEqual(fresh,old);
    t=performance.now();const small=after.summary(wallet);const summaryMs=performance.now()-t;
    assert.equal(small.directCount,old.directCount);assert.equal(small.teamCount,old.teamCount);assert.equal(small.directReferrer,old.directReferrer);
    const api=createATokenApi({walletService,teamService:after,send:(res,status,data)=>Object.assign(res,{status,data}),readBody:async()=>({}),getSession:req=>req.session});
    const guest={};await api.handle({method:'GET'},guest,'/api/a-token/team/summary');assert.equal(guest.status,401);
    const response={};await api.handle({method:'GET',session:{address:wallet}},response,'/api/a-token/team/summary');assert.equal(response.status,200);assert.deepEqual(response.data,small);
    results.push({wallet:wallet.slice(0,8)+'…'+wallet.slice(-6),direct_count:small.directCount,team_count:small.teamCount,
      baseline_full_ms:Math.round(oldMs),optimized_full_ms:Math.round(newMs),summary_ms:Number(summaryMs.toFixed(2)),profile_identical:true,authenticated_api_verified:true});
  }
  assert(results.length>0);
  console.log(JSON.stringify({isolated_database:true,accounts_checked:results.length,results}));
} catch(error) {
  console.log(JSON.stringify({error:String(error.message)}));process.exitCode=1;
} finally {closeDatabase(copy);}
'''

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
            check = subprocess.run(['node', '--input-type=module', '--check'], input=data, capture_output=True, timeout=5)
            if check.returncode:
                raise RuntimeError('Candidate syntax failed: ' + name)
        originals[name] = (root / name).read_bytes()
        metadata[name] = (root / name).stat()
    verification_copy = backup / 'verification-data'
    verification_copy.mkdir(mode=0o700)
    db = readonly()
    dest = sqlite3.connect(str(verification_copy / 'wg-platform.sqlite'))
    db.backup(dest)
    dest.close()
    db.close()
    verified = subprocess.run(['node', '--input-type=module', '-e', probe, str(root), str(candidate), str(verification_copy)],
                              capture_output=True, text=True, timeout=45)
    if verified.returncode:
        raise RuntimeError('Isolated candidate verification failed: ' + verified.stdout[-1500:])
    verification = json.loads(verified.stdout)
    (backup / 'candidate-verification.json').write_text(json.dumps(verification, ensure_ascii=False, indent=2), encoding='utf-8')
    guard('before')
    with tarfile.open(backup / 'previous.tar.gz', 'w:gz') as archive:
        for name in order:
            archive.add(root / name, arcname=name)
    manifest = {name: {k:v for k,v in item.items() if k != 'body'} for name,item in files.items()}
    (backup / 'source-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    stopped = True
    subprocess.run(['systemctl', 'stop', 'wg-platform'], check=True, capture_output=True, timeout=8)
    guard('before')
    db = readonly()
    dest = sqlite3.connect(str(backup / 'before.sqlite'))
    db.backup(dest)
    dest.close()
    before_balances = balances(db)
    before_rewards = rewards(db)
    db.close()
    switched = True
    for name in order:
        replace(name, (candidate / name).read_bytes(), 'next')
    guard('after')
    db = readonly()
    if balances(db) != before_balances or rewards(db) != before_rewards:
        raise RuntimeError('Ledger changed while the service was stopped')
    db.close()
    subprocess.run(['systemctl', 'start', 'wg-platform'], check=True, capture_output=True, timeout=8)
    stopped = False
    base = 'http://127.0.0.1:8082'
    ready = False
    for attempt in range(15):
        try:
            with urllib.request.urlopen(base + '/api/wallet/session', timeout=1) as response:
                if json.load(response).get('authenticated') is False:
                    ready = True
                    break
        except Exception:
            time.sleep(0.3)
    if not ready:
        raise RuntimeError('Application readiness failed')
    current = service()
    if current.get('ActiveState') != 'active' or current.get('SubState') != 'running' or current.get('MainPID') == previous.get('MainPID'):
        raise RuntimeError('Restarted service state is invalid')
    static = []
    for uri, name in [('/', 'public/index.html'), ('/js/earn.js?v=20261011-team-fast-2', 'public/js/earn.js')]:
        with urllib.request.urlopen(base + uri, timeout=3) as response:
            digest = sha(response.read())
            if digest != files[name]['after']:
                raise RuntimeError('Origin content mismatch: ' + uri)
            static.append({'uri':uri, 'status':response.status, 'sha256':digest})
    try:
        urllib.request.urlopen(base + '/api/a-token/team/summary', timeout=3)
        raise RuntimeError('Summary endpoint allowed unauthenticated access')
    except urllib.error.HTTPError as error:
        if error.code != 401 or json.load(error).get('code') != 'SESSION_REQUIRED':
            raise RuntimeError('Summary authentication check failed')
    guard('after')
    db = readonly()
    after_balances = balances(db)
    after_rewards = rewards(db)
    db.close()
    changes = [w for w,v in before_balances.items() if after_balances.get(w) != v]
    out = {'deployed':True, 'release':release, 'backup_directory':str(backup),
           'completed_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'files':order, 'service':current, 'service_restarted':True,
           'protected_sources_unchanged':True, 'env_unchanged':True,
           'balances_checked':len(before_balances), 'balance_changes_after_service_resumed':len(changes),
           'reward_rows_unchanged_after_restart':after_rewards == before_rewards,
           'ledger_unchanged_during_file_switch':True, 'database_restored':False,
           'candidate_verification':verification, 'summary_requires_login':True, 'static':static}
except Exception as error:
    rollback_errors = []
    if switched:
        try:
            subprocess.run(['systemctl', 'stop', 'wg-platform'], check=True, capture_output=True, timeout=8)
            stopped = True
            for name in order:
                replace(name, originals[name], 'rollback')
            guard('before')
        except Exception as rollback_error:
            rollback_errors.append(str(rollback_error))
    if stopped:
        try:
            subprocess.run(['systemctl', 'start', 'wg-platform'], check=True, capture_output=True, timeout=8)
            stopped = False
        except Exception as restart_error:
            rollback_errors.append(str(restart_error))
    out = {'deployed':False, 'release':release, 'backup_directory':str(backup), 'error':str(error),
           'rolled_back':switched and not rollback_errors, 'rollback_errors':rollback_errors, 'database_restored':False}
if backup.exists():
    (backup / 'deployment-result.json').write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(out, ensure_ascii=False, indent=2))
