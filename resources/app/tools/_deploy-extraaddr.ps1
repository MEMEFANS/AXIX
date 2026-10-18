param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_cred.ps1"

$appRoot = 'C:\Users\cy020\Desktop\WG-Grid-Studio-' + ([char]0x5B8C + [char]0x6574 + [char]0x6210 + [char]0x4EA4 + [char]0x8D26 + [char]0x672C) + '\resources\app'
$rel = 'src/a-token-activation-service.js'
$local = Join-Path $appRoot $rel
$remote = "$remoteRoot/$rel"

$md5Local = (Get-FileHash -Algorithm MD5 $local).Hash.ToLower()

$ssh = New-SSHSession -ComputerName $IP -Credential $cred -ErrorOnUntrusted -ConnectionTimeout 120
$sid = $ssh.SessionId

$r0 = Invoke-SSHCommand -SessionId $sid -Command "md5sum $remote 2>/dev/null || echo MISSING" -TimeOut 20
$before = ($r0.Output -join ' ').Trim()
Write-Output "LOCAL_MD5  $md5Local"
Write-Output "REMOTE_MD5 $before"

if ($CheckOnly) {
  Remove-SSHSession -SessionId $sid | Out-Null
  Write-Output '[DONE check-only]'
  exit 0
}

$b64 = [System.Convert]::ToBase64String([System.IO.File]::ReadAllBytes($local))
Invoke-SSHCommand -SessionId $sid -Command "cp $remote ${remote}.bak-extraaddr-20261014 2>/dev/null; rm -f /tmp/_up.b64" -TimeOut 20 | Out-Null
for ($i = 0; $i -lt $b64.Length; $i += 40000) {
  $len = [Math]::Min(40000, $b64.Length - $i)
  $r = Invoke-SSHCommand -SessionId $sid -Command "printf '%s' '$($b64.Substring($i,$len))' >> /tmp/_up.b64" -TimeOut 30
  if ($r.ExitStatus -ne 0) { throw "upload chunk failed at $i" }
}
$r = Invoke-SSHCommand -SessionId $sid -Command "base64 -d /tmp/_up.b64 > $remote && rm -f /tmp/_up.b64 && md5sum $remote" -TimeOut 30
$remoteMd5 = ($r.Output | Select-Object -First 1).Split(' ')[0].ToLower()
if ($remoteMd5 -ne $md5Local) { throw "MD5 mismatch local=$md5Local remote=$remoteMd5" }
Write-Output "MD5_OK $rel"

Write-Output '==== RESTART ===='
$r2 = Invoke-SSHCommand -SessionId $sid -Command "systemctl restart wg-platform; sleep 3; systemctl is-active wg-platform" -TimeOut 60
Write-Output ($r2.Output -join ' ')

Write-Output '==== VERIFY ===='
$chk = "grep -n 'extraAddresses' $remote; echo '---'; grep -n 'rejectReason' $remote; echo '--- logs ---'; (systemctl show -p MainPID --value wg-platform)"
$r3 = Invoke-SSHCommand -SessionId $sid -Command $chk -TimeOut 30
Write-Output ($r3.Output -join "`n")

Write-Output '==== STRAY FILE (read-only) ===='
# NOTE: 这里只做只读检查。绝不要再对 'wg-platform.sqlite*' 用通配删除——
# 2026-10-14 曾因此误删 /opt 下的 -shm/-wal 与 4 个 .bak-* 备份快照。
# 如需删除某个具体文件，请用精确文件名（含引号），不要用 glob。
$r4 = Invoke-SSHCommand -SessionId $sid -Command "ls -la /opt/wg-platform/ | grep -i sqlite" -TimeOut 30
Write-Output ($r4.Output -join "`n")

Remove-SSHSession -SessionId $sid | Out-Null
Write-Output '[DONE]'
