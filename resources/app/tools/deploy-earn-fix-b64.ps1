# Deploy earn.js + index.html via SSH base64 streaming (most reliable fallback).
# Memory-verified path: SFTP/Set-SFTPItem has chroot/quiet-failure issues; pscp -hostkey rejects long hex.
# SSH base64 streaming bypasses all of these.
param()
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_cred.ps1"
$LocalApp = 'c:\Users\cy020\Desktop\WG-Grid-Studio-' + [char]0x5B8C + [char]0x6574 + [char]0x6210 + [char]0x4EA4 + [char]0x8D26 + [char]0x672C + '\resources\app'

$files = @(
  @{ rel = 'public/js/earn.js';  dst = '/opt/wg-platform/public/js/earn.js' }
  @{ rel = 'public/index.html';  dst = '/opt/wg-platform/public/index.html' }
)

function Get-CrStrippedMd5([string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $ms = New-Object System.IO.MemoryStream
  foreach ($b in $bytes) { if ($b -ne 13) { [void]$ms.WriteByte($b) } }
  $md5 = [System.Security.Cryptography.MD5]::Create()
  $hb = $md5.ComputeHash($ms.ToArray())
  $ms.Dispose()
  return ([System.BitConverter]::ToString($hb) -replace '-','').ToLower()
}

# --- Step 1: Open SSH session ---
Write-Output '[1] Open SSH session...'
$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 120
$sid = $ssh.SessionId

# --- Step 2: Build CR-stripped temp copies + compute local MD5 ---
Write-Output '[2] Build CR-stripped temp copies + local MD5...'
$tempDir = Join-Path $env:TEMP 'wg-deploy-earn-fix-b64'
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
New-Item -Path $tempDir -ItemType Directory | Out-Null
$tempFiles = @()
foreach ($f in $files) {
  $local = Join-Path $LocalApp ($f.rel -replace '/','\')
  $name  = [System.IO.Path]::GetFileName($f.dst)
  $temp  = Join-Path $tempDir $name
  $bytes = [System.IO.File]::ReadAllBytes($local)
  $clean = New-Object System.IO.MemoryStream
  foreach ($b in $bytes) { if ($b -ne 13) { [void]$clean.WriteByte($b) } }
  [System.IO.File]::WriteAllBytes($temp, $clean.ToArray())
  $clean.Dispose()
  $localMd5 = Get-CrStrippedMd5 $local
  $tempFiles += @{ temp = $temp; dst = $f.dst; name = $name; localMd5 = $localMd5; size = (Get-Item $temp).Length }
  Write-Output ("    {0} : {1} bytes, CR-stripped MD5={2}" -f $name, $tempFiles[-1].size, $localMd5)
}

# --- Step 3: Base64-stream upload in chunks to /tmp on server ---
# Strategy: split base64 into 4KB chunks; for each chunk run:
#   echo -n '<chunk>' >> /tmp/_dep_<name>.b64
# Then: base64 -d < /tmp/_dep_<name>.b64 > /tmp/_dep_<name>
# Chunked echo avoids hitting shell argv/SSH packet limits on large files.
Write-Output '[3] Base64-stream upload (chunked echo >> /tmp)...'
$chunkSize = 4096
foreach ($tf in $tempFiles) {
  $bytes = [System.IO.File]::ReadAllBytes($tf.temp)
  $b64   = [System.Convert]::ToBase64String($bytes)
  $remoteB64 = "/tmp/_dep_$($tf.name).b64"
  $remoteBin  = "/tmp/_dep_$($tf.name)"

  # reset file
  $r = Invoke-SSHCommand -SessionId $sid -Command "rm -f $remoteB64 $remoteBin; touch $remoteB64" -TimeOut 15

  $total = [int]([Math]::Ceiling($b64.Length / [double]$chunkSize))
  $i = 0
  $pos = 0
  while ($pos -lt $b64.Length) {
    $end = [Math]::Min($pos + $chunkSize, $b64.Length)
    $chunk = $b64.Substring($pos, $end - $pos)
    $pos = $end
    $i++
    # use printf to avoid interpretation of backslashes; single-quote wrap chunk
    $cmd = "printf %s '$chunk' >> $remoteB64"
    $r = Invoke-SSHCommand -SessionId $sid -Command $cmd -TimeOut 30
    if ($i % 10 -eq 0 -or $i -eq $total) {
      Write-Output ("    {0}: chunk {1}/{2} ({3}%)" -f $tf.name, $i, $total, [int]($i * 100 / $total))
    }
  }

  # decode base64 -> binary
  $r = Invoke-SSHCommand -SessionId $sid -Command "base64 -d < $remoteB64 > $remoteBin && rm -f $remoteB64 && wc -c < $remoteBin" -TimeOut 30
  $rsize = ($r.Output -join '').Trim()
  if ($rsize -ne $tf.size.ToString()) {
    Write-Output ("    [ERROR] {0} decode size mismatch: local={1} remote={2}" -f $tf.name, $tf.size, $rsize)
  } else {
    Write-Output ("    [OK] {0} decoded on server ({1}B)" -f $tf.name, $rsize)
  }
}

# --- Step 4: Move into place + MD5 verify via SSH ---
Write-Output '[4] Backup + move + MD5 verify...'
$allOk = $true
foreach ($tf in $tempFiles) {
  $remoteBin = "/tmp/_dep_$($tf.name)"
  $dst = $tf.dst
  $stamp = Get-Date -Format yyyyMMddHHmmss
  $bak = "${dst}.bak-earnfix-$stamp"
  $mvCmd = "cp -p $dst $bak 2>/dev/null; cp $remoteBin $dst && rm -f $remoteBin && echo MOVED"
  $r = Invoke-SSHCommand -SessionId $sid -Command $mvCmd -TimeOut 30
  Write-Output ("    {0}: {1}" -f $tf.name, ($r.Output -join ' '))
  $md5Cmd = "tr -d '\r' < $dst | md5sum | cut -d' ' -f1"
  $r = Invoke-SSHCommand -SessionId $sid -Command $md5Cmd -TimeOut 30
  $remoteMd5 = ($r.Output -join '').Trim().ToLower()
  if ($remoteMd5 -eq $tf.localMd5) {
    Write-Output ("    [OK] {0} MD5 match: {1}" -f $tf.name, $remoteMd5)
  } else {
    Write-Output ("    [FAIL] {0} local={1} remote={2}" -f $tf.name, $tf.localMd5, $remoteMd5)
    $allOk = $false
  }
}

# --- Cleanup ---
Remove-SSHSession -SessionId $sid | Out-Null
Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue

if ($allOk) {
  Write-Output "[DONE] Both files deployed + MD5 verified. Ctrl+F5 to load earn.js?v=20260928-activation-local-1"
} else {
  Write-Output "[ERROR] MD5 mismatch - deployment NOT verified. Check errors above."
  exit 1
}
