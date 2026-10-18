param([int]$From, [int]$To)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. "$PSScriptRoot/_cred.ps1"

$localFile = Join-Path $PSScriptRoot 'scanpay.mjs'
$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 60
$sid = $ssh.SessionId
$b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($localFile))

$cmd = "echo '$b64' | base64 -d > /tmp/scanpay.mjs && node /tmp/scanpay.mjs $From $To 2>&1"
$r = Invoke-SSHCommand -SessionId $sid -Command $cmd -TimeOut 600
$r.Output | ForEach-Object { Write-Output $_ }
if ($r.Error) { $r.Error | ForEach-Object { Write-Output $_ } }
Remove-SSHSession -SessionId $sid | Out-Null
