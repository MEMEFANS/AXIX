# Query miner activation records for a wallet on production server.
param([string]$Wallet = '0x03e4b9f93f300901191b0aeff7368021f3f254f4')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_cred.ps1"

Write-Output '[1] SSH connect...'
$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 120
if (-not $ssh) { throw 'SSH connect failed' }
$sid = $ssh.SessionId

$nodeScript = @"
const Database = require('/opt/wg-platform/node_modules/better-sqlite3');
const fs = require('fs');
const path = require('path');
const w = '$Wallet';
const wl = w.toLowerCase();
function findDb(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...findDb(p)); }
    else if (/\.(db|sqlite3?|sqlite)$/i.test(e.name)) out.push(p);
  }
  return out;
}
const dbs = findDb('/opt/wg-platform');
for (const f of dbs) {
  try {
    const db = new Database(f, { readonly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    const hit = tables.filter(t => /activation|miner/i.test(t));
    if (!hit.length) { db.close(); continue; }
    console.log('DB:', f, 'tables:', hit.join(','));
    for (const t of hit) {
      const cols = db.prepare('PRAGMA table_info(' + t + ')').all().map(c => c.name);
      const walletCol = cols.find(c => /^wallet|wallet$/i.test(c));
      if (!walletCol) { console.log('  [' + t + '] no wallet col, cols:', cols.join(',')); continue; }
      const rows = db.prepare('SELECT * FROM ' + t + ' WHERE ' + walletCol + ' IN (?,?) ORDER BY rowid DESC LIMIT 20').all(wl, w);
      console.log('  [' + t + '] rows for wallet: ' + rows.length);
      for (const r of rows) console.log('   ', JSON.stringify(r));
    }
    db.close();
  } catch (e) { console.log('skip', f, e.message.slice(0, 100)); }
}
"@

$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($nodeScript))
$cmd = "cd /opt/wg-platform && echo `"$encoded`" | base64 -d > /tmp/qminer.cjs && node /tmp/qminer.cjs; rm -f /tmp/qminer.cjs"

Write-Output '[2] Run query...'
$r = Invoke-SSHCommand -SessionId $sid -Command $cmd -TimeOut 60
Write-Output $r.Output
if ($r.Error) { Write-Output "STDERR: $($r.Error)" }
Remove-SSHSession -SessionId $sid | Out-Null
Write-Output '[done]'
