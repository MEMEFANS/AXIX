param()
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_cred.ps1"
$LocalApp = 'c:\Users\cy020\Desktop\WG-Grid-Studio-' + [char]0x5B8C + [char]0x6574 + [char]0x6210 + [char]0x4EA4 + [char]0x8D26 + [char]0x672C + '\resources\app'

$localPath = Join-Path $LocalApp 'src\server.js'
$remoteDst = '/opt/wg-platform/src/server.js'

function Get-CrMd5([string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $ms = New-Object System.IO.MemoryStream
  foreach ($b in $bytes) { if ($b -ne 13) { [void]$ms.WriteByte($b) } }
  $md5 = [System.Security.Cryptography.MD5]::Create()
  $hb = $md5.ComputeHash($ms.ToArray())
  $ms.Dispose()
  return ([System.BitConverter]::ToString($hb) -replace '-','').ToLower()
}

$bytes = [System.IO.File]::ReadAllBytes($localPath)
$ms = New-Object System.IO.MemoryStream
foreach ($b in $bytes) { if ($b -ne 13) { [void]$ms.WriteByte($b) } }
$cleanBytes = $ms.ToArray()
$ms.Dispose()
$localMd5 = Get-CrMd5 $localPath
$size = $cleanBytes.Length
Write-Output ('Local: {0} bytes, MD5={1}' -f $size, $localMd5)

$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 120
$sid = $ssh.SessionId

$b64 = [System.Convert]::ToBase64String($cleanBytes)
$remoteB64 = '/tmp/_dep_server.js.b64'
$remoteBin = '/tmp/_dep_server.js'

Invoke-SSHCommand -SessionId $sid -Command "rm -f $remoteB64 $remoteBin; touch $remoteB64" -TimeOut 15 | Out-Null

$chunk = 8192
$total = [int]([Math]::Ceiling($b64.Length / [double]$chunk))
$pos = 0
$i = 0
while ($pos -lt $b64.Length) {
  $end = [Math]::Min($pos + $chunk, $b64.Length)
  $c = $b64.Substring($pos, $end - $pos)
  $pos = $end
  $i++
  $cmd = "printf %s '$c' >> $remoteB64"
  $r = Invoke-SSHCommand -SessionId $sid -Command $cmd -TimeOut 30
  if ($i % 5 -eq 0 -or $i -eq $total) {
    Write-Output ('  chunk {0}/{1} ({2}%)' -f $i, $total, [int]($i*100/$total))
  }
}

$decodeCmd = "base64 -d $remoteB64 > $remoteBin; rm -f $remoteB64; wc -c < $remoteBin"
$r = Invoke-SSHCommand -SessionId $sid -Command $decodeCmd -TimeOut 30
$remoteSize = ($r.Output -join '').Trim()
if ($remoteSize -ne $size.ToString()) {
  Write-Output ('[ERROR] size mismatch local={0} remote={1}' -f $size, $remoteSize)
  exit 1
}
Write-Output ('[OK] decoded {0}B' -f $remoteSize)

$md5Cmd = "md5sum $remoteBin | cut -d' ' -f1"
$r = Invoke-SSHCommand -SessionId $sid -Command $md5Cmd -TimeOut 30
$remoteMd5 = ($r.Output -join '').Trim().ToLower()
if ($remoteMd5 -ne $localMd5) {
  Write-Output ('[FAIL] MD5 mismatch local={0} remote={1}' -f $localMd5, $remoteMd5)
  exit 1
}
Write-Output ('[OK] MD5 match: {0}' -f $remoteMd5)

$stamp = Get-Date -Format yyyyMMddHHmmss
$bak = "/opt/wg-platform/src/server.js.bak-rot-off-$stamp"
$mvCmd = "cp -p $remoteDst $bak 2>/dev/null; cp $remoteBin $remoteDst; rm -f $remoteBin; echo MOVED"
$r = Invoke-SSHCommand -SessionId $sid -Command $mvCmd -TimeOut 30
Write-Output ('Move: {0}' -f ($r.Output -join ' '))

Write-Output 'Restarting wg-platform...'
$r = Invoke-SSHCommand -SessionId $sid -Command 'sudo systemctl restart wg-platform; sleep 2; systemctl is-active wg-platform' -TimeOut 60
$status = ($r.Output -join ' ').Trim()
Write-Output ('Status: {0}' -f $status)

Remove-SSHSession -SessionId $sid | Out-Null
Write-Output '[DONE] Rotation address disabled.'
