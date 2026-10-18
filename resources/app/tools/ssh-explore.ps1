# Deep verification: case-insensitive search, platform-wide activation status, error log.
param([string]$Wallet = '0x03e4b9f93f300901191b0aeff7368021f3f254f4')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_cred.ps1"

$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 120
$sid = $ssh.SessionId

$cmds = @(
  'tail -60 /opt/wg-platform/logs/server.stderr.log'
)
foreach ($c in $cmds) {
  Write-Output "===== $c"
  $r = Invoke-SSHCommand -SessionId $sid -Command $c -TimeOut 40
  Write-Output $r.Output
  if ($r.Error) { Write-Output "STDERR: $($r.Error)" }
}

$nodeScript = @"
const { DatabaseSync } = require('node:sqlite');
const w = '$Wallet';
const db = new DatabaseSync('/opt/wg-platform/wg-platform.sqlite', { readOnly: true });
// 1. case-insensitive search everywhere
const frag = w.toLowerCase().slice(2); // strip 0x
for (const t of ['a_token_activations','a_token_miners','a_token_miner_releases']) {
  const rows = db.prepare('SELECT * FROM ' + t + ' WHERE CAST(payload_json AS TEXT) LIKE ? OR CAST(id AS TEXT) LIKE ? LIMIT 10').all('%' + frag + '%', '%' + frag + '%');
  console.log('LIKE-SEARCH [' + t + ']:', rows.length);
  for (const r of rows) console.log(JSON.stringify(r).slice(0, 500));
}
// 2. platform-wide activation overview
const cnt = db.prepare('SELECT status, COUNT(*) n FROM a_token_activations GROUP BY status').all();
console.log('ACTIVATION STATUS COUNTS:', JSON.stringify(cnt));
const recent = db.prepare('SELECT payload_json FROM a_token_activations ORDER BY rowid DESC LIMIT 12').all();
console.log('RECENT 12 ACTIVATIONS:');
for (const r of recent) { const p = JSON.parse(r.payload_json); console.log(JSON.stringify({id:p.id, wallet:p.wallet, plan:p.plan, status:p.status, createdAt:p.createdAt, confirmedAt:p.confirmedAt, txHash:(p.txHash||'').slice(0,18)+'...', reject:p.payload?.rejectReason||p.rejectReason||''})); }
// 3. recent miners
const miners = db.prepare('SELECT payload_json FROM a_token_miners ORDER BY rowid DESC LIMIT 8').all();
console.log('RECENT 8 MINERS:');
for (const r of miners) { const p = JSON.parse(r.payload_json); console.log(JSON.stringify({wallet:p.wallet, plan:p.plan, status:p.status, startedAt:p.startedAt})); }
db.close();
"@
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($nodeScript))
$cmd = "echo `"$encoded`" | base64 -d > /tmp/q4.cjs && node /tmp/q4.cjs; rm -f /tmp/q4.cjs"
Write-Output '===== DEEP QUERY'
$r = Invoke-SSHCommand -SessionId $sid -Command $cmd -TimeOut 60
Write-Output $r.Output
if ($r.Error) { Write-Output "STDERR: $($r.Error)" }
Remove-SSHSession -SessionId $sid | Out-Null
