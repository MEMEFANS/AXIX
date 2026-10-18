$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. "$PSScriptRoot/_cred.ps1"

$localFile = Join-Path $PSScriptRoot 'chk-stuck.mjs'
$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 60
$sid = $ssh.SessionId
$b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($localFile))
$md5 = (Get-FileHash -Algorithm MD5 -Path $localFile).Hash.ToLower()
Write-Host "md5=$md5"

$cmd = "echo '$b64' | base64 -d > /opt/wg-platform/scripts/chk-stuck.mjs && cd /opt/wg-platform && node scripts/chk-stuck.mjs 2>&1 | grep -v ExperimentalWarning | grep -v trace-warnings; rm -f /opt/wg-platform/scripts/chk-stuck.mjs"
$r = Invoke-SSHCommand -SessionId $sid -Command $cmd -TimeOut 900
$r.Output | ForEach-Object { Write-Output $_ }
if ($r.Error) { $r.Error | ForEach-Object { Write-Output $_ } }
Remove-SSHSession -SessionId $sid | Out-Null
