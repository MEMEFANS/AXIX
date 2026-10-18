# SSH/SFTP deploy helper (Posh-SSH)
# Usage:
#   .\ssh-helper.ps1 -Action deploy              # one-click: diff->backup->upload->verify->restart
#   .\ssh-helper.ps1 -Action deploy -DryRun      # only list diffs, no upload/restart
#   .\ssh-helper.ps1 -Action deploy -NoRestart   # deploy but skip service restart (frontend-only)
#   .\ssh-helper.ps1 -Action manifest            # only pull server manifest
#   .\ssh-helper.ps1 -Action service             # only restart service
# NOTE: keep this file pure ASCII (no CJK/emoji) so Windows PowerShell 5.1 parses it safely.
param(
  [string]$Action = 'manifest',
  [switch]$DryRun,
  [switch]$NoRestart
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_cred.ps1"
$LocalApp = 'c:\Users\cy020\Desktop\WG-Grid-Studio-' + [char]0x5B8C + [char]0x6574 + [char]0x6210 + [char]0x4EA4 + [char]0x8D26 + [char]0x672C + '\resources\app'
$ToolsDir = Join-Path $LocalApp 'tools'
$ScanDirs = @('src','public','scripts','contracts','frontend')

# Local hash matching server `tr -d '\r' | md5sum`: strip CR (0x0D) bytes then MD5.
function Get-CrStrippedMd5([string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $ms = New-Object System.IO.MemoryStream
  foreach ($b in $bytes) { if ($b -ne 13) { [void]$ms.WriteByte($b) } }
  $md5 = [System.Security.Cryptography.MD5]::Create()
  $hb = $md5.ComputeHash($ms.ToArray())
  $ms.Dispose()
  return ([System.BitConverter]::ToString($hb) -replace '-','').ToLower()
}

# Collect local files -> @{ relativePath = CR-stripped MD5 }
function Get-LocalInventory {
  $map = @{}
  foreach ($d in $ScanDirs) {
    $base = Join-Path $LocalApp $d
    if (Test-Path $base) {
      Get-ChildItem $base -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($LocalApp.Length+1) -replace '\\','/'
        $map[$rel] = Get-CrStrippedMd5 $_.FullName
      }
    }
  }
  $pkg = Join-Path $LocalApp 'package.json'
  if (Test-Path $pkg) { $map['package.json'] = Get-CrStrippedMd5 $pkg }
  return $map
}

# Pull server manifest -> @{ relativePath = MD5 }
function Get-RemoteInventory($SessionId) {
  $cmd = 'cd /opt/wg-platform && for d in src public scripts contracts frontend; do find "$d" -type f | while read f; do h=$(tr -d ''\r'' < "$f" | md5sum | cut -d'' '' -f1); echo "$h  $f"; done; done; h=$(tr -d ''\r'' < package.json | md5sum | cut -d'' '' -f1); echo "$h  package.json"'
  $r = Invoke-SSHCommand -SessionId $SessionId -Command $cmd -TimeOut 120
  if ($r.Error) { Write-Output ("STDERR: " + ($r.Error -join "`n")) }
  $map = @{}
  foreach ($line in $r.Output) {
    if ($line.Trim() -match '^([0-9a-f]{32})\s+(.+)$') { $map[$Matches[2].Trim()] = $Matches[1].ToLower() }
  }
  return $map
}

$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 30
$sftp = New-SFTPSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 30
try {
  switch ($Action) {
    'manifest' {
      $cmd = 'cd /opt/wg-platform && for d in src public scripts contracts frontend; do find "$d" -type f | while read f; do h=$(tr -d ''\r'' < "$f" | md5sum | cut -d'' '' -f1); echo "$h  $f"; done; done; h=$(tr -d ''\r'' < package.json | md5sum | cut -d'' '' -f1); echo "$h  package.json"'
      $r = Invoke-SSHCommand -SessionId $ssh.SessionId -Command $cmd -TimeOut 120
      if ($r.Error) { Write-Output ("STDERR: " + ($r.Error -join "`n")) }
      $r.Output | Out-File -Encoding utf8 (Join-Path $ToolsDir 'server-manifest.txt')
      Write-Output "SERVER_FILES=$($r.Output.Count)"
    }
    'deploy' {
      Write-Output '== [1/6] Scan local files =='
      $localInv = Get-LocalInventory
      Write-Output "LOCAL_FILES=$($localInv.Count)"

      Write-Output '== [2/6] Pull server manifest and compare =='
      $remoteInv = Get-RemoteInventory $ssh.SessionId
      $diff = @()
      foreach ($rel in ($localInv.Keys | Sort-Object)) {
        $sh = $remoteInv[$rel]
        if (-not $sh -or $sh -ne $localInv[$rel]) { $diff += $rel }
      }
      $newFiles = @($diff | Where-Object { -not $remoteInv.ContainsKey($_) })
      $chgFiles = @($diff | Where-Object { $remoteInv.ContainsKey($_) })

      if ($diff.Count -eq 0) { Write-Output '[OK] Local and server are identical. Nothing to deploy.'; break }
      Write-Output "Found $($diff.Count) differing file(s) (new $($newFiles.Count) / changed $($chgFiles.Count)):"
      $diff | ForEach-Object { $tag = if ($remoteInv.ContainsKey($_)) { 'CHG' } else { 'NEW' }; Write-Output "  [$tag] $_" }

      if ($DryRun) { Write-Output "`n[DRYRUN] No backup, no upload, no restart."; break }

      # Backup files that already exist on the server (cp --parents keeps directory tree)
      Write-Output "`n== [3/6] Backup server files =="
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      $backupDir = "backups/sync-$stamp"
      if ($chgFiles.Count -gt 0) {
        $bkList = ($chgFiles -join ' ')
        $bkCmd = "cd /opt/wg-platform && mkdir -p $backupDir && cp --parents $bkList $backupDir/ 2>/dev/null; echo BACKUP_DONE"
        $rb = Invoke-SSHCommand -SessionId $ssh.SessionId -Command $bkCmd -TimeOut 120
        Write-Output "Backed up $($chgFiles.Count) existing file(s) -> $backupDir"
      } else {
        Write-Output 'All files are new, nothing to back up.'
      }

      Write-Output "`n== [4/6] Upload files =="
      $ok = 0; $fail = 0; $failed = @()
      foreach ($rel in $diff) {
        $local = Join-Path $LocalApp ($rel -replace '/','\')
        $remote = "$RemoteRoot/$rel"
        if (-not (Test-Path $local)) { Write-Output "MISSING_LOCAL: $rel"; $fail++; $failed += $rel; continue }
        $remoteDir = $remote.Substring(0, $remote.LastIndexOf('/'))
        $parts = $remoteDir.Split('/')
        $cur = ''
        foreach ($p in $parts[1..($parts.Length-1)]) {
          $cur += "/$p"
          try { $null = New-SFTPItem -SessionId $sftp.SessionId -Path $cur -ItemType Directory -ErrorAction Stop } catch {}
        }
        try {
          Set-SFTPItem -SessionId $sftp.SessionId -Path $local -Destination $remoteDir -Force
          Write-Output "  UPLOADED: $rel"; $ok++
        } catch { Write-Output "  FAIL: $rel -> $($_.Exception.Message)"; $fail++; $failed += $rel }
      }
      Write-Output "Upload done: ok $ok / fail $fail"

      if ($fail -gt 0) { Write-Output "`n[WARN] $fail file(s) failed to upload; aborting verify/restart: $($failed -join ', ')"; break }

      Write-Output "`n== [5/6] Verify upload (re-pull manifest and compare) =="
      $remoteInv2 = Get-RemoteInventory $ssh.SessionId
      $mismatch = @()
      foreach ($rel in $diff) {
        if ($remoteInv2[$rel] -ne $localInv[$rel]) { $mismatch += $rel; Write-Output "  MISMATCH: $rel" }
      }
      if ($mismatch.Count -gt 0) { Write-Output "[WARN] $($mismatch.Count) file(s) verify mismatch: $($mismatch -join ', ')"; break }
      Write-Output "[OK] All $($diff.Count) file(s) verified by MD5."

      Write-Output "`n== [6/6] Service handling =="
      $backendChanged = @($diff | Where-Object { $_ -like 'src/*' -or $_ -eq 'package.json' })
      if ($backendChanged.Count -gt 0) {
        if ($NoRestart) {
          Write-Output "Backend file(s) changed ($($backendChanged.Count)) but -NoRestart given; skipping restart."
          Write-Output 'NOTE: backend changes need a restart to take effect: .\ssh-helper.ps1 -Action service'
        } else {
          Write-Output "Backend file(s) changed ($($backendChanged.Count)); restarting service..."
          $cmd = 'systemctl restart wg-platform && sleep 3 && systemctl is-active wg-platform && journalctl -u wg-platform -n 8 --no-pager'
          $r = Invoke-SSHCommand -SessionId $ssh.SessionId -Command $cmd -TimeOut 60
          Write-Output ($r.Output -join "`n")
          if ($r.Error) { Write-Output ("STDERR: " + ($r.Error -join "`n")) }
        }
      } else {
        Write-Output 'Frontend/static-only changes; no restart needed. Refresh page to see updates.'
      }
      Write-Output "`n[DONE] Deploy finished. Backup: /opt/wg-platform/$backupDir"
    }
    'upload' {
      $listFile = Join-Path $ToolsDir 'upload-list.txt'
      $files = Get-Content $listFile | Where-Object { $_.Trim() }
      $ok = 0; $fail = 0
      foreach ($rel in $files) {
        $rel = $rel.Trim() -replace '\\','/'
        $local = Join-Path $LocalApp ($rel -replace '/','\')
        $remote = "$RemoteRoot/$rel"
        if (-not (Test-Path $local)) { Write-Output "MISSING_LOCAL: $rel"; $fail++; continue }
        $remoteDir = $remote.Substring(0, $remote.LastIndexOf('/'))
        $parts = $remoteDir.Split('/')
        $cur = ''
        foreach ($p in $parts[1..($parts.Length-1)]) {
          $cur += "/$p"
          try { $null = New-SFTPItem -SessionId $sftp.SessionId -Path $cur -ItemType Directory -ErrorAction Stop } catch {}
        }
        try {
          Set-SFTPItem -SessionId $sftp.SessionId -Path $local -Destination $remoteDir -Force
          Write-Output "UPLOADED: $rel"
          $ok++
        } catch { Write-Output "FAIL: $rel -> $($_.Exception.Message)"; $fail++ }
      }
      Write-Output "UPLOAD_DONE ok=$ok fail=$fail"
    }
    'service' {
      $cmd = 'systemctl restart wg-platform && sleep 3 && systemctl is-active wg-platform && journalctl -u wg-platform -n 15 --no-pager'
      $r = Invoke-SSHCommand -SessionId $ssh.SessionId -Command $cmd -TimeOut 60
      Write-Output ($r.Output -join "`n")
      if ($r.Error) { Write-Output ("STDERR: " + ($r.Error -join "`n")) }
    }
    'exec' {
      $r = Invoke-SSHCommand -SessionId $ssh.SessionId -Command $env:REMOTE_CMD -TimeOut 120
      Write-Output ($r.Output -join "`n")
      if ($r.Error) { Write-Output ("STDERR: " + ($r.Error -join "`n")) }
    }
  }
} finally {
  Remove-SSHSession -SessionId $ssh.SessionId | Out-Null
  Remove-SFTPSession -SessionId $sftp.SessionId | Out-Null
}
