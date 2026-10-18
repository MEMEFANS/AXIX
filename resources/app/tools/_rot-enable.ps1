param()
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_cred.ps1"

function Push-Sh([string]$Script, [string]$Remote) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($Script -replace "`r", ""))
  $b64 = [System.Convert]::ToBase64String($bytes)
  $b64Path = "$Remote.b64"
  Invoke-SSHCommand -SessionId $script:sid -Command "rm -f $b64Path $Remote" -TimeOut 20 | Out-Null
  $chunk = 40000
  for ($i = 0; $i -lt $b64.Length; $i += $chunk) {
    $len = [Math]::Min($chunk, $b64.Length - $i)
    $c = $b64.Substring($i, $len)
    $r = Invoke-SSHCommand -SessionId $script:sid -Command "printf '%s' '$c' >> $b64Path" -TimeOut 30
    if ($r.ExitStatus -ne 0) { throw 'upload failed' }
  }
  $r = Invoke-SSHCommand -SessionId $script:sid -Command "base64 -d $b64Path > $Remote && rm -f $b64Path && sh $Remote" -TimeOut 90
  return ($r.Output -join "`n")
}

$applySh = @'
#!/bin/sh
set -e
WG_ENV_FILE=$(readlink -f /opt/wg-platform/.env)
cd "$(dirname "$WG_ENV_FILE")"
echo "==== BEFORE ===="
grep -n -E 'A_TOKEN_(COLLECTION_ADDRESS|ROTATION_|RECONCILE_EXTRA)' .env || true
STAMP=$(date +%Y%m%d%H%M%S)
cp -p .env ".env.bak-rot-$STAMP"
grep -v -E '^[#[:space:]]*A_TOKEN_(ROTATION_|RECONCILE_EXTRA_ADDRESSES)' .env > .env.new || true
printf '%s\n' \
  'A_TOKEN_ROTATION_ADDRESS=0x811241eec576b7306b619121d08927e1bcdcb562' \
  'A_TOKEN_ROTATION_ADDRESSES=1:0x7eaec5ac8ba673772125ee5082b8dc45469ce4bd,2:0x811241eec576b7306b619121d08927e1bcdcb562' \
  'A_TOKEN_ROTATION_PLAN=1,2' \
  'A_TOKEN_ROTATION_EVERY=3' \
  'A_TOKEN_RECONCILE_EXTRA_ADDRESSES=0x084a93fa28bb85eba1930ec8f067900142e83b83,0x67cdadd5c917c9f4da193169f73591774ab45850,0x8209cf26bbfc579b4a0de0c8c170a8223009545b' >> .env.new
chown --reference=.env .env.new
chmod --reference=.env .env.new
mv .env.new .env
echo "==== AFTER ===="
grep -n -E 'A_TOKEN_(COLLECTION_ADDRESS|ROTATION_|RECONCILE_EXTRA)' .env
echo "==== BACKUP ===="
ls -1 ".env.bak-rot-$STAMP"
'@

$checkSh = @'
#!/bin/sh
cd /opt/wg-platform
P=$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '\r ' )
echo "APP PORT=$P"
echo "---- collectionAddressByPlan ----"
curl -s "http://127.0.0.1:$P/api/a-token/plans" | tr ',' '\n' | grep -nE 'collectionAddress|^"[12]":'
'@

$ssh = New-SSHSession -ComputerName $IP -Credential $cred -ErrorOnUntrusted -ConnectionTimeout 120
$script:sid = $ssh.SessionId

Write-Output '==== APPLY ===='
Write-Output (Push-Sh -Script $applySh -Remote '/tmp/_rot.sh')

Write-Output '==== RESTART ===='
$r2 = Invoke-SSHCommand -SessionId $script:sid -Command "systemctl restart wg-platform; sleep 3; systemctl is-active wg-platform" -TimeOut 60
Write-Output ($r2.Output -join ' ')

Write-Output '==== VERIFY ===='
Write-Output (Push-Sh -Script $checkSh -Remote '/tmp/_rotchk.sh')

Remove-SSHSession -SessionId $script:sid | Out-Null
Write-Output '[DONE]'
