# Verify backfill result after auto-confirm window.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_cred.ps1"
$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 120
$sid = $ssh.SessionId
$nodeScript = @"
import { DatabaseSync } from 'node:sqlite';
const wl = '0xc7432637244e6d4d01ab976857b9b280d929e883';
const frag = wl.slice(2);
const db = new DatabaseSync('/opt/wg-platform/wg-platform.sqlite', { readOnly: true });
let rows = db.prepare('SELECT payload_json FROM a_token_activations WHERE payload_json LIKE ? ORDER BY rowid DESC LIMIT 3').all('%' + frag + '%');
console.log('ACTIVATIONS:', rows.length);
for (const r of rows) { const p = JSON.parse(r.payload_json); console.log(JSON.stringify({id:p.id, plan:p.plan, status:p.status, confirmedAt:p.confirmedAt, txHash:(p.txHash||'').slice(0,20)})); }
rows = db.prepare('SELECT payload_json FROM a_token_miners WHERE payload_json LIKE ? ORDER BY rowid DESC LIMIT 5').all('%' + frag + '%');
console.log('MINERS:', rows.length);
for (const r of rows) { const p = JSON.parse(r.payload_json); console.log(JSON.stringify({id:p.id, plan:p.plan, status:p.status, startedAt:p.startedAt})); }
rows = db.prepare('SELECT wallet,change,balance,type,ref_id,created_at FROM lottery_flows WHERE wallet=? ORDER BY created_at DESC LIMIT 5').all(wl);
console.log('FLOWS:', rows.length);
for (const r of rows) console.log(JSON.stringify(r));
db.close();
"@
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($nodeScript))
$cmd = "echo `"$encoded`" | base64 -d > /tmp/qv.mjs && cd /opt/wg-platform && node /tmp/qv.mjs; rm -f /tmp/qv.mjs"
$r = Invoke-SSHCommand -SessionId $sid -Command $cmd -TimeOut 60
Write-Output $r.Output
if ($r.Error) { Write-Output "STDERR: $($r.Error)" }
Remove-SSHSession -SessionId $sid | Out-Null
