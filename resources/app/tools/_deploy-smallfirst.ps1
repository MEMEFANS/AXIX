param()
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_cred.ps1"

$appRoot = 'C:\Users\cy020\Desktop\WG-Grid-Studio-' + ([char]0x5B8C + [char]0x6574 + [char]0x6210 + [char]0x4EA4 + [char]0x8D26 + [char]0x672C) + '\resources\app'

$ssh = New-SSHSession -ComputerName $IP -Credential $cred -ErrorOnUntrusted -ConnectionTimeout 120
$sid = $ssh.SessionId

function Push-Sh([string]$Script, [string]$Remote) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($Script -replace "`r", ""))
  $b64 = [System.Convert]::ToBase64String($bytes)
  Invoke-SSHCommand -SessionId $sid -Command "rm -f $Remote.b64 $Remote" -TimeOut 20 | Out-Null
  for ($i = 0; $i -lt $b64.Length; $i += 40000) {
    $len = [Math]::Min(40000, $b64.Length - $i)
    $r = Invoke-SSHCommand -SessionId $sid -Command "printf '%s' '$($b64.Substring($i,$len))' >> $Remote.b64" -TimeOut 30
    if ($r.ExitStatus -ne 0) { throw "push chunk failed: $Remote" }
  }
  $r = Invoke-SSHCommand -SessionId $sid -Command "base64 -d $Remote.b64 > $Remote && rm -f $Remote.b64 && sh $Remote" -TimeOut 90
  return ($r.Output -join "`n")
}

Write-Output '==== UPLOAD ===='
foreach ($rel in @('src/a-token-order-service.js', 'src/server.js')) {
  $local = Join-Path $appRoot $rel
  $remote = "$remoteRoot/$rel"
  $md5Local = (Get-FileHash -Algorithm MD5 $local).Hash.ToLower()
  $b64 = [System.Convert]::ToBase64String([System.IO.File]::ReadAllBytes($local))
  Invoke-SSHCommand -SessionId $sid -Command "cp $remote ${remote}.bak-smallfirst-20261014 2>/dev/null; rm -f /tmp/_up.b64" -TimeOut 20 | Out-Null
  for ($i = 0; $i -lt $b64.Length; $i += 40000) {
    $len = [Math]::Min(40000, $b64.Length - $i)
    $r = Invoke-SSHCommand -SessionId $sid -Command "printf '%s' '$($b64.Substring($i,$len))' >> /tmp/_up.b64" -TimeOut 30
    if ($r.ExitStatus -ne 0) { throw "upload chunk failed: $rel" }
  }
  $r = Invoke-SSHCommand -SessionId $sid -Command "base64 -d /tmp/_up.b64 > $remote && rm -f /tmp/_up.b64 && md5sum $remote" -TimeOut 30
  $remoteMd5 = ($r.Output | Select-Object -First 1).Split(' ')[0].ToLower()
  if ($remoteMd5 -ne $md5Local) { throw "MD5 mismatch: $rel local=$md5Local remote=$remoteMd5" }
  Write-Output "MD5_OK $rel"
}

Write-Output '==== RESTART ===='
$r2 = Invoke-SSHCommand -SessionId $sid -Command "systemctl restart wg-platform; sleep 3; systemctl is-active wg-platform" -TimeOut 60
Write-Output ($r2.Output -join ' ')

Write-Output '==== VERIFY ===='
$chkSh = @'
set -eu
cd /opt/wg-platform
P=$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '\r ')
echo "--- collectionAddressByPlan (rotation should stay OFF) ---"
curl -s -m 10 "http://127.0.0.1:$P/api/a-token/plans" | grep -o 'collectionAddressByPlan[^}]*}'
echo "--- code markers ---"
grep -c 'matchSmallFirstWindow\|matchSmallFirstCount' src/server.js src/a-token-order-service.js
grep -c 'smallFirstAt' src/a-token-order-service.js
'@
Write-Output (Push-Sh -Script $chkSh -Remote '/tmp/_chk.sh')

Remove-SSHSession -SessionId $sid | Out-Null
Write-Output '[DONE]'
