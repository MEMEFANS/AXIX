import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const audit = import.meta.dirname;
const app = path.resolve(audit, '../../resources/app');
const uri = name => pathToFileURL(path.join(app, 'src', name)).href;
const { openDatabase, closeDatabase } = await import(uri('database.js'));
const { createATokenTeamService } = await import(uri('a-token-team-service.js'));
let source = fs.readFileSync(path.join(audit, 'before/src/a-token-team-service.js'), 'utf8');
for (const name of ['a-token-ledger.js', 'a-token-income.js']) source = source.replaceAll("'./" + name + "'", JSON.stringify(uri(name)));
source = source.replaceAll("'ethers'", JSON.stringify(pathToFileURL(path.join(app, 'node_modules/ethers/lib.esm/index.js')).href));
const old = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const dataRoot = path.join(audit, 'benchmark-data');
try {
  const db = openDatabase(dataRoot);
  const balances = new Map(db.db.prepare('SELECT address,balances_json FROM wallet_users').all()
    .map(row => [row.address.toLowerCase(), JSON.parse(row.balances_json)]));
  const walletService = { balanceUnits: (wallet, asset) => BigInt(balances.get(wallet.toLowerCase())?.[asset] || '0') };
  const baseline = old.createATokenTeamService({ database: db, walletService });
  const candidate = createATokenTeamService({ database: db, walletService });
  const digest = sql => crypto.createHash('sha256').update(JSON.stringify(db.db.prepare(sql).all())).digest('hex');
  const walletBefore = digest('SELECT address,balances_json FROM wallet_users ORDER BY address');
  const rewardsBefore = digest('SELECT * FROM a_token_team_rewards ORDER BY id');
  const accounts = db.db.prepare("SELECT referrer_wallet AS wallet,COUNT(*) AS c FROM platform_referral_links WHERE referrer_wallet IS NOT NULL GROUP BY referrer_wallet ORDER BY c DESC LIMIT 3").all();
  const results = [];
  for (const { wallet } of accounts) {
    let started = performance.now();
    const expected = baseline.profile(wallet);
    const baselineMs = performance.now() - started;
    started = performance.now();
    const actual = candidate.profile(wallet);
    const candidateMs = performance.now() - started;
    assert.deepEqual(actual, expected);
    started = performance.now();
    const summary = candidate.summary(wallet);
    const summaryMs = performance.now() - started;
    assert.equal(summary.teamCount, expected.teamCount);
    assert.equal(summary.directCount, expected.directCount);
    assert.equal(summary.directReferrer, expected.directReferrer);
    results.push({ wallet: wallet.slice(0, 8) + '…' + wallet.slice(-6), direct_count: summary.directCount,
      team_count: summary.teamCount, baseline_full_ms: Math.round(baselineMs), optimized_full_ms: Math.round(candidateMs),
      summary_ms: Number(summaryMs.toFixed(2)), full_profile_identical: true });
  }
  assert.equal(digest('SELECT address,balances_json FROM wallet_users ORDER BY address'), walletBefore);
  assert.equal(digest('SELECT * FROM a_token_team_rewards ORDER BY id'), rewardsBefore);
  const result = { isolated_local_snapshot: true, accounts_checked: results.length, results,
    balances_unchanged: true, rewards_unchanged: true, captured_at_utc: new Date().toISOString() };
  fs.writeFileSync(path.join(audit, 'local-benchmark-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  closeDatabase(dataRoot);
}
