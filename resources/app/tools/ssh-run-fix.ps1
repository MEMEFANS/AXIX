# Upload + run a miner backfill fix script on production.
param([string]$LocalName = 'fix-missing-miner-20261009.mjs')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_cred.ps1"

$local = Join-Path $PSScriptRoot $LocalName
$bytes = [IO.File]::ReadAllBytes($local)
# strip CR for linux
$ms = New-Object IO.MemoryStream
foreach ($b in $bytes) { if ($b -ne 13) { [void]$ms.WriteByte($b) } }
$b64 = [Convert]::ToBase64String($ms.ToArray())
$ms.Dispose()

$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 120
$sid = $ssh.SessionId

# upload via base64 (single chunk ~6KB fine)
$cmd = "echo `"$b64`" | base64 -d > /opt/wg-platform/scripts/$LocalName && wc -c /opt/wg-platform/scripts/$LocalName"
$r = Invoke-SSHCommand -SessionId $sid -Command $cmd -TimeOut 30
Write-Output $r.Output
if ($r.Error) { Write-Output "UPLOAD STDERR: $($r.Error)"; Remove-SSHSession -SessionId $sid | Out-Null; exit 1 }

# dry sanity: node syntax check first
$r = Invoke-SSHCommand -SessionId $sid -Command "cd /opt/wg-platform && node --check scripts/$LocalName && echo SYNTAX_OK" -TimeOut 30
Write-Output $r.Output
if ($r.Output -notmatch 'SYNTAX_OK') { Write-Output 'syntax check failed, abort'; Remove-SSHSession -SessionId $sid | Out-Null; exit 1 }

# run
Write-Output '===== RUN FIX'
$r = Invoke-SSHCommand -SessionId $sid -Command "cd /opt/wg-platform && node scripts/$LocalName" -TimeOut 120
Write-Output $r.Output
if ($r.Error) { Write-Output "RUN STDERR: $($r.Error)" }
Remove-SSHSession -SessionId $sid | Out-Null
Write-Output '[done]'
