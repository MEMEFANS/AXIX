param([string]$Wallet = '0xd97e39ae8e45f021cc4add44f2ec7b42a5c9e792')
$ErrorActionPreference = 'Stop'
Import-Module Posh-SSH
. "$PSScriptRoot/_cred.ps1"

$localRoot = Split-Path $PSScriptRoot -Parent
$localFile = Join-Path $localRoot 'tools\team-level-diag.mjs'

$ssh = $null
for ($i = 1; $i -le 6; $i++) {
  try { $ssh = New-SSHSession -ComputerName $server -Credential $cred -AcceptKey -Force -ConnectionTimeout 25; break }
  catch { Start-Sleep -Seconds (3 * $i) }
}
if (-not $ssh) { throw 'SSH failed' }

try {
  $bytes = [System.IO.File]::ReadAllBytes($localFile)
  $b64 = [Convert]::ToBase64String($bytes)
  $tmpB64 = '/opt/wg-platform/team-level-diag.b64'
  $chunkSize = 50000
  $totalChunks = [Math]::Ceiling($b64.Length / $chunkSize)
  $first = $b64.Substring(0, [Math]::Min($chunkSize, $b64.Length))
  $null = Invoke-SSHCommand -SessionId $ssh.SessionId -Command "printf '%s' '$first' > $tmpB64" -TimeOut 30
  for ($i = 1; $i -lt $totalChunks; $i++) {
    $start = $i * $chunkSize
    $len = [Math]::Min($chunkSize, $b64.Length - $start)
    $chunk = $b64.Substring($start, $len)
    $null = Invoke-SSHCommand -SessionId $ssh.SessionId -Command "printf '%s' '$chunk' >> $tmpB64" -TimeOut 30
  }
  Write-Host "uploaded $totalChunks chunks"

  $cmd = @'
cd /opt/wg-platform
base64 -d team-level-diag.b64 > team-level-diag.mjs
node team-level-diag.mjs TARGETWALLET 2>&1 | grep -v ExperimentalWarning | grep -v trace-warnings
rm -f team-level-diag.mjs team-level-diag.b64
echo RUN_DONE
'@
  $cmd = $cmd.Replace('TARGETWALLET', $Wallet.ToLower())
  $r = Invoke-SSHCommand -SessionId $ssh.SessionId -Command $cmd -TimeOut 120
  Write-Host ($r.Output -join "`n")
  if ($r.Error) { Write-Host "STDERR: $($r.Error)" }
} finally {
  Get-SSHSession | Remove-SSHSession | Out-Null
}
