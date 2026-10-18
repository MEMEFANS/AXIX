# Deploy wallet-service.js isRealUser fix
$ErrorActionPreference = 'Stop'
Import-Module Posh-SSH
. "$PSScriptRoot/_cred.ps1"
$localRoot = Split-Path $PSScriptRoot -Parent
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

$ssh = $null
for ($i = 1; $i -le 6; $i++) {
  try { $ssh = New-SSHSession -ComputerName $server -Credential $cred -AcceptKey -Force -ConnectionTimeout 25; break }
  catch { Start-Sleep -Seconds (3 * $i) }
}
if (-not $ssh) { throw 'SSH failed' }

function Invoke-Remote([string]$cmdStr, [int]$timeoutSec = 30) {
  for ($try = 1; $try -le 4; $try++) {
    try { return Invoke-SSHCommand -SessionId $script:ssh.SessionId -Command $cmdStr -TimeOut $timeoutSec }
    catch {
      Write-Host "retry $try ..."; Start-Sleep -Seconds (2 * $try)
      Get-SSHSession | Remove-SSHSession | Out-Null
      $script:ssh = $null
      for ($i = 1; $i -le 6; $i++) {
        try { $script:ssh = New-SSHSession -ComputerName $server -Credential $cred -AcceptKey -Force -ConnectionTimeout 25; break }
        catch { Start-Sleep -Seconds (3 * $i) }
      }
      if (-not $script:ssh) { throw 'SSH reconnect failed' }
    }
  }
}

function Send-FileB64([string]$localPath, [string]$remotePath) {
  $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($localPath))
  $tmp = "$remotePath.b64tmp"
  $chunkSize = 50000
  $n = [Math]::Ceiling($b64.Length / $chunkSize)
  $null = Invoke-Remote "printf '%s' '$($b64.Substring(0,[Math]::Min($chunkSize,$b64.Length)))' > $tmp"
  for ($i = 1; $i -lt $n; $i++) {
    $start = $i * $chunkSize
    $null = Invoke-Remote "printf '%s' '$($b64.Substring($start, [Math]::Min($chunkSize, $b64.Length - $start)))' >> $tmp"
  }
  $null = Invoke-Remote "base64 -d $tmp > $remotePath && rm -f $tmp"
  Write-Host "uploaded: $(Split-Path $localPath -Leaf) ($n chunks)"
}

try {
  $remotePath = '/opt/wg-platform/src/wallet-service.js'
  Write-Host '=== backup ==='
  $r = Invoke-Remote "mkdir -p /opt/wg-platform/backups/isrealuser-$stamp/src && cp $remotePath /opt/wg-platform/backups/isrealuser-$stamp/src/ && echo BACKUP_OK"
  Write-Host ($r.Output -join "`n")

  Write-Host '=== stop + upload ==='
  $r = Invoke-Remote "systemctl stop wg-platform && sleep 2 && echo STOPPED"
  Write-Host ($r.Output -join "`n")
  Send-FileB64 (Join-Path $localRoot 'src\wallet-service.js') $remotePath
  $r = Invoke-Remote "cd /opt/wg-platform && node --check src/wallet-service.js 2>&1 && echo CHECK_OK"
  Write-Host ($r.Output -join "`n")
  if (($r.Output -join "`n") -notmatch 'CHECK_OK') { throw 'syntax check failed' }

  Write-Host '=== start ==='
  $r = Invoke-Remote "systemctl start wg-platform; sleep 9; systemctl is-active wg-platform"
  Write-Host ($r.Output -join "`n")

  Write-Host '=== verify ==='
  $r = Invoke-Remote "curl -s 'http://127.0.0.1:8082/api/admin/users' -H 'Cookie: wg_admin_session=test' 2>/dev/null | head -c 50; echo; curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8082/; echo"
  Write-Host ($r.Output -join "`n")
  echo DEPLOY_DONE
} finally {
  Get-SSHSession | Remove-SSHSession | Out-Null
}
