import sqlite3, json, datetime, pathlib, tempfile, subprocess, hashlib, gzip, base64

root = pathlib.Path('/opt/wg-platform')
now = datetime.datetime.now(datetime.timezone.utc)
bj = datetime.timezone(datetime.timedelta(hours=8))
start = datetime.datetime.combine(now.astimezone(bj).date(), datetime.time.min, bj)
day = int(start.timestamp() * 1000)
out = {'captured_at_utc': now.isoformat(), 'day_start_beijing': start.isoformat(), 'sources': {}}
# Inspect the live ledger read-only. Settlement replay only touches a private,
# disposable copy and uses simulated wallet credits.
with tempfile.TemporaryDirectory(prefix='wg-reward-check-') as temp:
    db = sqlite3.connect('file:' + str(root / 'wg-platform.sqlite') + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    dest = sqlite3.connect(str(pathlib.Path(temp) / 'wg-platform.sqlite'))
    db.backup(dest); dest.close()
    db.execute('PRAGMA query_only=ON'); db.execute('BEGIN')
    bykind = {}
    for row in db.execute('SELECT kind,amount_units FROM a_token_team_rewards WHERE created_at>=?', (day,)):
        value = bykind.setdefault(row['kind'], {'count': 0, 'units': 0})
        value['count'] += 1; value['units'] += int(row['amount_units'])
    out['today_by_kind'] = {k: {'count': v['count'], 'amount_units': str(v['units'])} for k,v in bykind.items()}
    out['yesterday_eligible_income_recipients'] = db.execute("SELECT COUNT(DISTINCT recipient_wallet) FROM a_token_team_rewards WHERE kind IN ('miner_team','stake_team','miner_level_diff','stake_level_diff') AND created_at>=? AND created_at<?", (day-86400000, day)).fetchone()[0]
    db.rollback(); db.close()
    for name in ['src/platform-service.js', 'src/server.js', 'src/a-token-income.js', 'src/a-token-revenue-service.js', 'src/a-token-team-service.js', 'src/a-token-ledger.js', 'src/database.js', 'public/js/operator-admin.js', 'public/admin.html']:
        data = (root / name).read_bytes()
        out['sources'][name] = {'sha256': hashlib.sha256(data).hexdigest(), 'gzip_base64': base64.b64encode(gzip.compress(data)).decode()}
    code = r'''
import {openDatabase,closeDatabase} from '/opt/wg-platform/src/database.js';
import {createATokenTeamService} from '/opt/wg-platform/src/a-token-team-service.js';
const root=process.env.WG_AUDIT_COPY, now=Number(process.env.WG_AUDIT_NOW);
const db=openDatabase(root), credits=[];
const wallet={
 balanceUnits:(w,a)=>BigInt(JSON.parse(db.db.prepare('SELECT balances_json FROM wallet_users WHERE address=? COLLATE NOCASE').get(w)?.balances_json||'{}')[a]||'0'),
 creditBalance:(w,a,n)=>credits.push({wallet:w,asset:a,units:n.toString()}),
 beginAtomicUpdate:()=>({isDirty:()=>false,finish:()=>{},rollback:()=>{}}),
};
const service=createATokenTeamService({database:db,walletService:wallet});
const before=db.db.prepare("SELECT COUNT(*) AS n FROM a_token_team_rewards WHERE kind='parity'").get().n;
const result=service.settleParityRewards(now);
const added=db.db.prepare("SELECT COUNT(*) AS n FROM a_token_team_rewards WHERE kind='parity'").get().n-before;
const firstCredits=credits.slice(); credits.length=0;
const replay=service.settleParityRewards(now);
const levels=db.db.prepare('SELECT wallet,level FROM a_token_team_levels WHERE level>0').all();
console.log(JSON.stringify({settlement:result,added_rows:added,missing_credits:firstCredits,replay,replay_credits:credits,levels}));
closeDatabase(root);
'''
    import os
    env = dict(os.environ, WG_AUDIT_COPY=temp, WG_AUDIT_NOW=str(int(now.timestamp()*1000)))
    result = subprocess.run(['node', '--input-type=module', '-e', code], cwd=root, env=env, capture_output=True, text=True, timeout=75)
    if result.returncode:
        raise RuntimeError('Isolated settlement verification failed: ' + result.stderr[-2000:])
    out['isolated_production_parity_replay'] = json.loads(result.stdout)
print(json.dumps(out, ensure_ascii=False))
