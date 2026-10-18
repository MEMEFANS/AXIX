param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. "$PSScriptRoot/_cred.ps1"

$localFile = Join-Path $PSScriptRoot 'fix-missing-miner-pro-8b2a-20261014.mjs'
$remoteName = 'fix-missing-miner-pro-8b2a-20261014.mjs'

$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 60
$sid = $ssh.SessionId

$bytes = [System.IO.File]::ReadAllBytes($localFile)
$b64 = [Convert]::ToBase64String($bytes)
Write-Host "uploading $($bytes.Length) bytes ..."

$cmd = "mkdir -p /opt/wg-platform/scripts && echo '$b64' | base64 -d > /opt/wg-platform/scripts/$remoteName && wc -c /opt/wg-platform/scripts/$remoteName && md5sum /opt/wg-platform/scripts/$remoteName"
$r = Invoke-SSHCommand -SessionId $sid -Command $cmd -TimeOut 120
$r.Output | ForEach-Object { Write-Output $_ }
if ($r.Error) { $r.Error | ForEach-Object { Write-Output $_ } }

$localMd5 = (Get-FileHash -Algorithm MD5 -Path $localFile).Hash.ToLower()
Write-Host "local md5: $localMd5"

$run = "cd /opt/wg-platform && node scripts/$remoteName 2>&1 | grep -v ExperimentalWarning | grep -v trace-warnings"
$r2 = Invoke-SSHCommand -SessionId $sid -Command $run -TimeOut 180
Write-Host "----- script output -----"
$r2.Output | ForEach-Object { Write-Output $_ }
if ($r2.Error) { $r2.Error | ForEach-Object { Write-Output $_ } }

Remove-SSHSession -SessionId $sid | Out-Null
