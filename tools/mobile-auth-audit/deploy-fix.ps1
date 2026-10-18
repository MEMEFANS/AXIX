param([string]$StagedRelease = '')
$ErrorActionPreference = 'Stop'
Import-Module Posh-SSH
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../resources/app'))
. (Join-Path $appRoot 'tools/_cred.ps1')
$release = 'mobile-auth-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$files = @('src/wallet-service.js','src/server.js','public/js/wallet.js','public/js/earn.js','public/js/i18n.js','public/js/page-loader.js','public/sw.js','public/index.html')
$baseline = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'remote-current-manifest.json') -Raw | ConvertFrom-Json
$manifest = @{}
$expected = @{}
$hashLines = @()
foreach ($file in $files) {
  $hash = (Get-FileHash -LiteralPath (Join-Path $appRoot $file) -Algorithm SHA256).Hash.ToLower()
  $manifest[$file] = $hash
  $expected[$file] = $baseline.$file.sha256
  if (!$expected[$file]) { throw ('Missing production baseline: '+$file) }
  $hashLines += $hash + '  ' + $file
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'deploy-manifest.json') -Encoding utf8
$archive = Join-Path $PSScriptRoot ($release + '.tar.gz')
& tar -czf $archive -C $appRoot @files
if ($LASTEXITCODE -ne 0) { throw 'Package creation failed' }
$archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower()
$hashBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($hashLines -join "`n")+"`n"))
$expectedBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($expected | ConvertTo-Json -Compress)))
$preflight = @'
import json,base64,hashlib
root='/opt/wg-platform/'
for name,wanted in json.loads(base64.b64decode('__EXPECTED__')).items():
    with open(root+name,'rb') as f: body=f.read().replace(b'\r',b'')
    if hashlib.sha256(body).hexdigest()!=wanted: raise RuntimeError('Concurrent production change: '+name)
print('PRODUCTION_BASELINE_MATCHED')
'@
$preflight = $preflight.Replace('__EXPECTED__',$expectedBase64)
$preflightBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($preflight))
$payload = [Convert]::ToBase64String([IO.File]::ReadAllBytes($archive))
$ssh = $null
for ($attempt=0; !$ssh; ++$attempt) {
  try { $ssh = New-SSHSession -ComputerName $IP -Credential $cred -ErrorOnUntrusted -ConnectionTimeout 25 }
  catch { if ($attempt -ge 2) { throw }; Start-Sleep -Seconds (2 + $attempt) }
}
function Invoke-FixRemote([string]$command, [int]$timeout = 50) {
  $r = Invoke-SSHCommand -SessionId $ssh.SessionId -Command $command -TimeOut $timeout
  if ($r.ExitStatus -ne 0) {throw ('Deployment failed: '+($r.Error -join ' ')+' '+($r.Output -join ' '))}
  return $r.Output
}
try {
  $tmp = '/tmp/' + $release
  $chunks = @()
  if ($StagedRelease -and $StagedRelease -notmatch '^mobile-auth-\d{8}-\d{6}$') { throw 'Invalid staging release' }
  if (!$StagedRelease) { Invoke-FixRemote "mkdir -p '$tmp'" | Out-Null }
  for ($position=0; !$StagedRelease -and $position -lt $payload.Length; $position+=16384) {
    $name = ('chunk-{0:D4}' -f $chunks.Count)
    $chunk = $payload.Substring($position,[Math]::Min(16384,$payload.Length-$position))
    Invoke-FixRemote "printf '%s' '$chunk' > '$tmp/$name'" | Out-Null
    $chunks += "'$tmp/$name'"
  }
  $command = @'
set -eu
root='/opt/wg-platform'
tmp='/tmp/__RELEASE__'
stage="$tmp/stage"
backup="$root/backups/__RELEASE__"
__PREPARE__
printf '%s' '__HASHES__' | base64 -d > "$tmp/manifest.sha256"
cd "$stage"
sha256sum -c "$tmp/manifest.sha256"
for file in __FILES__; do case "$file" in *.js) node --input-type=module --check < "$file";; esac; done
printf '%s' '__PREFLIGHT__' | base64 -d | timeout 25s python3
cd "$root"
systemctl is-active --quiet wg-platform
mkdir -p "$backup"
tar -czf "$backup/previous.tar.gz" __FILES__
echo BACKUP_READY
success=0
rollback() {
  trap - EXIT
  if test "$success" != 1; then
    cd "$root"
    tar -xzf "$backup/previous.tar.gz"
    timeout 35s systemctl restart wg-platform || true
    echo ROLLED_BACK
  fi
}
trap rollback EXIT
switch_file() {
  file="$1"
  cp "$stage/$file" "$file.next-__RELEASE__"
  chmod --reference="$file" "$file.next-__RELEASE__"
  chown --reference="$file" "$file.next-__RELEASE__"
  mv "$file.next-__RELEASE__" "$file"
}
switch_file src/wallet-service.js
switch_file src/server.js
timeout 35s systemctl restart wg-platform
ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 3 http://127.0.0.1:8082/api/wallet/session > "$tmp/session.json"; then ready=1; break; fi
  sleep 1
done
test "$ready" = 1
node -e "const p=JSON.parse(require('fs').readFileSync('$tmp/session.json','utf8'));if(p.authenticated!==false)process.exit(1)"
for file in 'public/js/wallet.js' 'public/js/earn.js' 'public/js/i18n.js' 'public/js/page-loader.js' 'public/sw.js' 'public/index.html'; do switch_file "$file"; done
sha256sum -c "$tmp/manifest.sha256"
systemctl is-active --quiet wg-platform
success=1
echo DEPLOYED_AND_VERIFIED
systemctl show wg-platform --property=ActiveState --property=SubState --property=MainPID
uptime
ps -p "$(systemctl show wg-platform --property=MainPID --value)" -o pcpu,rss,etimes
'@
  if ($StagedRelease) {
    $prepare = "mkdir -p '$tmp'; stage='/tmp/$StagedRelease/stage'"
  } else {
    $prepare = @'
cat __CHUNKS__ | base64 -d > "$tmp/package.tar.gz"
printf '%s  %s\n' '__ARCHIVE_HASH__' "$tmp/package.tar.gz" | sha256sum -c -
mkdir -p "$stage"
tar -xzf "$tmp/package.tar.gz" -C "$stage"
'@
  }
  $quotedFiles = ($files | ForEach-Object {"'$_'"}) -join ' '
  $command = $command.Replace('__PREPARE__',$prepare).Replace('__RELEASE__',$release).Replace('__CHUNKS__',($chunks -join ' ')).Replace('__ARCHIVE_HASH__',$archiveHash).Replace('__HASHES__',$hashBase64).Replace('__PREFLIGHT__',$preflightBase64).Replace('__FILES__',$quotedFiles)
  Invoke-FixRemote $command 90
  [PSCustomObject]@{release=$release;deployedAt=(Get-Date).ToString('o');backup=('/opt/wg-platform/backups/'+$release+'/previous.tar.gz');files=$files;backendRestarted=$true;serverSessionVerified=$true;sha256Verified=$true} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'deployment-result.json') -Encoding utf8
} finally {Remove-SSHSession -SessionId $ssh.SessionId | Out-Null}
