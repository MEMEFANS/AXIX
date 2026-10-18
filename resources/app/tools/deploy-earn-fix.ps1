# Deploy earn.js + index.html via SSH command channel + base64 (small chunks, reused session).
param()
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_cred.ps1"
$LocalApp = 'c:\Users\cy020\Desktop\WG-Grid-Studio-' + [char]0x5B8C + [char]0x6574 + [char]0x6210 + [char]0x4EA4 + [char]0x8D26 + [char]0x672C + '\resources\app'

$files = @(
  @{ rel = 'public/js/earn.js';   dst = '/opt/wg-platform/public/js/earn.js' }
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

Write-Output '[1] Connect SSH (timeout 120s)...'
$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 120
if (-not $ssh) { throw 'SSH connect failed' }
$sid = $ssh.SessionId
Write-Output ("    SSH_OK sid=$sid")

# backup
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bk = "backups/earn-fix-$stamp"
$r = Invoke-SSHCommand -SessionId $sid -Command "cd /opt/wg-platform && mkdir -p $bk && cp public/js/earn.js public/index.html $bk/ 2>/dev/null; echo BK_DONE $bk" -TimeOut 60
Write-Output ("    " + ($r.Output -join ' '))

foreach ($f in $files) {
  $local = Join-Path $LocalApp ($f.rel -replace '/','\')
  $dst   = $f.dst
  $name  = [System.IO.Path]::GetFileName($dst)
  $tmpB64 = "/tmp/_dep_$name.b64"
  Write-Output ("[2] Upload " + $f.rel + " via base64 chunks...")
  # read bytes, strip CR, base64
  $bytes = [System.IO.File]::ReadAllBytes($local)
  $clean = New-Object System.IO.MemoryStream
  foreach ($b in $bytes) { if ($b -ne 13) { [void]$clean.WriteByte($b) } }
  $b64 = [Convert]::ToBase64String($clean.ToArray())
  $clean.Dispose()
  # reset temp file
  $null = Invoke-SSHCommand -SessionId $sid -Command "rm -f $tmpB64" -TimeOut 30
  # chunked append (512 bytes per chunk to keep command short + stable)
  $chunk = 512
  $total = $b64.Length
  $n = [Math]::Ceiling($total / $chunk)
  Write-Output ("    total b64 length=$total chunks=$n")
  $ok = 0; $fail = 0
  for ($i = 0; $i -lt $n; $i++) {
    $seg = if ($i -eq $n - 1) { $b64.Substring($i * $chunk) } else { $b64.Substring($i * $chunk, $chunk) }
    # use printf '%s' with single-quoted segment (base64 has no single quotes)
    $r = Invoke-SSHCommand -SessionId $sid -Command "printf '%s' '$seg' >> $tmpB64" -TimeOut 15
    if ($r.Error) {
      $fail++
      if ($fail -le 3) { Write-Output ("    chunk $i STDERR: " + ($r.Error -join ' ')) }
      # reconnect if needed
      try { $null = Invoke-SSHCommand -SessionId $sid -Command "echo ALIVE" -TimeOut 10 } catch {
        Write-Output "    reconnecting SSH..."
        try { Remove-SSHSession -SessionId $sid | Out-Null } catch {}
        $ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 120
        $sid = $ssh.SessionId
        $null = Invoke-SSHCommand -SessionId $sid -Command "printf '%s' '$seg' >> $tmpB64" -TimeOut 15
      }
    } else { $ok++ }
    if ($i % 50 -eq 49) { Write-Output ("    progress $ok/$n") }
  }
  Write-Output ("    chunks ok=$ok fail=$fail")
  # verify b64 length on server
  $r = Invoke-SSHCommand -SessionId $sid -Command "wc -c < $tmpB64" -TimeOut 15
  Write-Output ("    server b64 bytes: " + ($r.Output -join '').Trim())
  # decode + move
  $r = Invoke-SSHCommand -SessionId $sid -Command "base64 -d $tmpB64 > $dst && rm -f $tmpB64 && echo MOVED $dst" -TimeOut 60
  Write-Output ("    " + ($r.Output -join ' '))
  if ($r.Error) { Write-Output ("    STDERR: " + ($r.Error -join ' ')) }
  # verify MD5
  $localMd5 = Get-CrStrippedMd5 $local
  $r = Invoke-SSHCommand -SessionId $sid -Command "tr -d '\r' < $dst | md5sum | cut -d' ' -f1" -TimeOut 30
  $remoteMd5 = ($r.Output -join '').Trim().ToLower()
  if ($remoteMd5 -eq $localMd5) {
    Write-Output ("    [OK] MD5 match " + $localMd5)
  } else {
    Write-Output ("    [FAIL] local=" + $localMd5 + " remote=" + $remoteMd5)
  }
}

Remove-SSHSession -SessionId $sid | Out-Null
Write-Output "[DONE] Ctrl+F5 to load earn.js?v=20260928-activation-local-1"
