$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$baseDir = $PSScriptRoot
if (-not $baseDir) { $baseDir = (Get-Location).Path }
. "$baseDir/_cred.ps1"

$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 60
$sid = $ssh.SessionId
$cmd = 'for i in $(seq 1 55); do grep -q LEAKSCAN_DONE /tmp/leakscan.log && break; sleep 10; done; tail -n 150 /tmp/leakscan.log'
$r = Invoke-SSHCommand -SessionId $sid -Command $cmd -TimeOut 600
$r.Output | ForEach-Object { Write-Output $_ }
if ($r.Error) { $r.Error | ForEach-Object { Write-Output $_ } }
Remove-SSHSession -SessionId $sid | Out-Null
