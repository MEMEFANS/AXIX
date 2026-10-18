$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$baseDir = $PSScriptRoot
if (-not $baseDir) { $baseDir = (Get-Location).Path }
. "$baseDir/_cred.ps1"

$js = @'
import Database from 'better-sqlite3';
const db = new Database('/opt/wg-platform/wg-platform.sqlite', { readonly: true, fileMustExist: true });
const row = db.prepare("SELECT payload_json FROM service_settings WHERE setting_key=?").get('a_token_activation_reconcile_v1');
console.log('RECONCILE_CURSOR=' + (row ? row.payload_json : 'NULL'));
console.log('PENDING_COUNT=' + db.prepare("SELECT COUNT(*) c FROM a_token_activations WHERE status='pending'").get().c);
console.log('CONFIRMED_COUNT=' + db.prepare("SELECT COUNT(*) c FROM a_token_activations WHERE status='confirmed'").get().c);
'@
$b64js = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($js))

$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 60
$sid = $ssh.SessionId

$cmd = @"
echo '=== hidden-char check on sqlite names ==='
ls -1b /opt/wg-platform | grep -i sqlite
echo '=== cursor read ==='
echo '$b64js' | base64 -d > /opt/wg-platform/_chk.mjs && node /opt/wg-platform/_chk.mjs; rm -f /opt/wg-platform/_chk.mjs
echo '=== app log tail ==='
tail -n 12 /opt/wg-platform/logs/server.stdout.log
"@
$r = Invoke-SSHCommand -SessionId $sid -Command $cmd -TimeOut 180
$r.Output | ForEach-Object { Write-Output $_ }
if ($r.Error) { $r.Error | ForEach-Object { Write-Output $_ } }
Remove-SSHSession -SessionId $sid | Out-Null
