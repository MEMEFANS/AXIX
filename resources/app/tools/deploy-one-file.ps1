param([string]$RelPath)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_cred.ps1"
$appRoot = 'C:\Users\cy020\Desktop\WG-Grid-Studio-' + ([char]0x5B8C + [char]0x6574 + [char]0x6210 + [char]0x4EA4 + [char]0x8D26 + [char]0x672C) + '\resources\app'
$local = Join-Path $appRoot $RelPath
$remote = "$remoteRoot/$RelPath"
$bytes = [System.IO.File]::ReadAllBytes($local)
$md5Local = (Get-FileHash -Algorithm MD5 $local).Hash.ToLower()
$b64 = [System.Convert]::ToBase64String($bytes)
$ssh = New-SSHSession -ComputerName $IP -Credential $cred -ErrorOnUntrusted -ConnectionTimeout 60
$sid = $ssh.SessionId
Invoke-SSHCommand -SessionId $sid -Command "cp $remote ${remote}.bak-429fix 2>/dev/null; rm -f /tmp/_up.b64 /tmp/_up.bin" -TimeOut 20 | Out-Null
$chunkSize = 8192
$ok = $true
for ($i = 0; $i -lt $b64.Length; $i += $chunkSize) {
  $len = [Math]::Min($chunkSize, $b64.Length - $i)
  $chunk = $b64.Substring($i, $len)
  $r = Invoke-SSHCommand -SessionId $sid -Command "printf '%s' '$chunk' >> /tmp/_up.b64" -TimeOut 30
  if ($r.ExitStatus -ne 0) { $ok = $false; break }
}
if ($ok) {
  $r = Invoke-SSHCommand -SessionId $sid -Command "base64 -d /tmp/_up.b64 > $remote && md5sum $remote && rm -f /tmp/_up.b64" -TimeOut 30
  Write-Output $r.Output
  $remoteMd5 = ($r.Output | Select-Object -First 1).Split(' ')[0].ToLower()
  if ($remoteMd5 -eq $md5Local) {
    Write-Output "MD5_OK"
    $r2 = Invoke-SSHCommand -SessionId $sid -Command "systemctl restart wg-platform && sleep 2 && systemctl is-active wg-platform" -TimeOut 60
    Write-Output "RESTART: $($r2.Output)"
  } else { Write-Output "MD5_MISMATCH local=$md5Local" }
} else { Write-Output "UPLOAD_FAILED" }
Remove-SSHSession -SessionId $sid | Out-Null
