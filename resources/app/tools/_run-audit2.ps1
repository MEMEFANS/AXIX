$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. "$PSScriptRoot/_cred.ps1"

$localFile = Join-Path $PSScriptRoot 'audit2.mjs'
$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 60
$sid = $ssh.SessionId
$b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($localFile))

$cmd = "echo '$b64' | base64 -d > /opt/wg-platform/scripts/audit2.mjs && cd /opt/wg-platform && node scripts/audit2.mjs 2>&1 | grep -v ExperimentalWarning | grep -v trace-warnings; rm -f /opt/wg-platform/scripts/audit2.mjs; echo ---ENV---; grep -iE 'COLLECT|ROTATION|ADDRESS|PLAN' /opt/wg-platform/.env | sed 's/=.*KEY.*/=<redacted>/'"
$r = Invoke-SSHCommand -SessionId $sid -Command $cmd -TimeOut 600
$r.Output | ForEach-Object { Write-Output $_ }
if ($r.Error) { $r.Error | ForEach-Object { Write-Output $_ } }
Remove-SSHSession -SessionId $sid | Out-Null
