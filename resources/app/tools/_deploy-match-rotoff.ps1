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

# ── 1) 上传两个源码文件（备份 + MD5 校验）──
Write-Output '==== UPLOAD ===='
foreach ($rel in @('src/a-token-order-service.js', 'src/server.js')) {
  $local = Join-Path $appRoot $rel
  $remote = "$remoteRoot/$rel"
  $md5Local = (Get-FileHash -Algorithm MD5 $local).Hash.ToLower()
  $b64 = [System.Convert]::ToBase64String([System.IO.File]::ReadAllBytes($local))
  Invoke-SSHCommand -SessionId $sid -Command "cp $remote ${remote}.bak-match-20261014 2>/dev/null; rm -f /tmp/_up.b64" -TimeOut 20 | Out-Null
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

# ── 2) 关闭轮换：PLAN=0（两个套餐都走主地址；地址保留以兼容历史/在途付款校验）──
Write-Output '==== ROTATION OFF (PLAN=0) ===='
$offSh = @'
set -eu
# Runtime configuration moved to a private data directory during server hardening.
WG_ENV_FILE=$(readlink -f /opt/wg-platform/.env)
cd "$(dirname "$WG_ENV_FILE")"
STAMP=$(date +%Y%m%d%H%M%S)
cp -p .env ".env.bak-rotoff-$STAMP"
grep -v -E '^[#[:space:]]*A_TOKEN_ROTATION_' .env > .env.new || true
printf '%s\n' \
  '# rotation disabled: PLAN=0 -> all plans use the main address (address kept for legacy verify/reconcile)' \
  'A_TOKEN_ROTATION_ADDRESS=0x084a93fa28bb85eba1930ec8f067900142e83b83' \
  'A_TOKEN_ROTATION_PLAN=0' \
  'A_TOKEN_ROTATION_EVERY=3' >> .env.new
chown --reference=.env .env.new
chmod --reference=.env .env.new
mv .env.new .env
echo "---- env after ----"
grep -nE 'A_TOKEN_ROTATION_|A_TOKEN_COLLECTION_' .env
echo "---- backup ----"
ls -1 ".env.bak-rotoff-$STAMP"
'@
Write-Output (Push-Sh -Script $offSh -Remote '/tmp/_off.sh')

# ── 3) 重启 ──
Write-Output '==== RESTART ===='
$r2 = Invoke-SSHCommand -SessionId $sid -Command "systemctl restart wg-platform; sleep 3; systemctl is-active wg-platform" -TimeOut 60
Write-Output ($r2.Output -join ' ')

# ── 4) 验证 ──
Write-Output '==== VERIFY ===='
$chkSh = @'
cd /opt/wg-platform
P=$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '\r ')
echo "--- collectionAddressByPlan ---"
curl -s -m 10 "http://127.0.0.1:$P/api/a-token/plans" | grep -o 'collectionAddressByPlan[^}]*}'
echo "--- code markers (server.js / a-token-order-service.js) ---"
grep -c 'matchSmallFirstEvery' src/server.js src/a-token-order-service.js
grep -c 'matchAttemptSeq' src/a-token-order-service.js
'@
Write-Output (Push-Sh -Script $chkSh -Remote '/tmp/_chk.sh')

Remove-SSHSession -SessionId $sid | Out-Null
Write-Output '[DONE]'
