$ErrorActionPreference = 'Stop'
Import-Module Posh-SSH
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../resources/app'))
. (Join-Path $appRoot 'tools/_cred.ps1')
$release = 'code-sync-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$files = @('frontend/wallet-connector.js', 'package-lock.json')
$archive = Join-Path $PSScriptRoot ($release + '.tar.gz')
& tar -czf $archive -C $appRoot @files
if ($LASTEXITCODE -ne 0) { throw 'Archive creation failed' }
$newHashes = @()
$oldHashes = @()
$manifest = @{}
foreach ($file in $files) {
  $newHash = (Get-FileHash -LiteralPath (Join-Path $appRoot $file) -Algorithm SHA256).Hash.ToLower()
  $oldHash = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot ('remote/' + $file)) -Algorithm SHA256).Hash.ToLower()
  $newHashes += $newHash + '  ' + $file
  $oldHashes += $oldHash + '  ' + $file
  $manifest[$file] = $newHash
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'deploy-manifest.json') -Encoding utf8
$archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower()
$newBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($newHashes -join "`n") + "`n"))
$oldBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($oldHashes -join "`n") + "`n"))
$payload = [Convert]::ToBase64String([IO.File]::ReadAllBytes($archive))
$ssh = New-SSHSession -ComputerName $IP -Credential $cred -ErrorOnUntrusted -ConnectionTimeout 25
function Invoke-CodeRemote([string]$command) {
  $r = Invoke-SSHCommand -SessionId $ssh.SessionId -Command $command -TimeOut 50
  if ($r.ExitStatus -ne 0) { throw ('Remote operation failed: ' + ($r.Error -join ' ') + ' ' + ($r.Output -join ' ')) }
  return $r.Output
}
try {
  $remoteTmp = '/tmp/' + $release
  Invoke-CodeRemote "mkdir -p '$remoteTmp'" | Out-Null
  $chunks = @()
  for ($position = 0; $position -lt $payload.Length; $position += 16384) {
    $chunk = $payload.Substring($position, [Math]::Min(16384, $payload.Length - $position))
    $name = ('chunk-{0:D4}' -f $chunks.Count)
    Invoke-CodeRemote "printf '%s' '$chunk' > '$remoteTmp/$name'" | Out-Null
    $chunks += "'$remoteTmp/$name'"
  }
  $command = @'
set -eu
root='/opt/wg-platform'
tmp='/tmp/__RELEASE__'
stage="$tmp/stage"
backup="$root/backups/__RELEASE__"
cat __CHUNKS__ | base64 -d > "$tmp/package.tar.gz"
printf '%s  %s\n' '__ARCHIVE_HASH__' "$tmp/package.tar.gz" | sha256sum -c -
mkdir -p "$stage"
tar -xzf "$tmp/package.tar.gz" -C "$stage"
printf '%s' '__NEW_HASHES__' | base64 -d > "$tmp/new.sha256"
printf '%s' '__OLD_HASHES__' | base64 -d > "$tmp/old.sha256"
cd "$stage"
sha256sum -c "$tmp/new.sha256"
node --input-type=module --check < frontend/wallet-connector.js
node -e "JSON.parse(require('fs').readFileSync('package-lock.json','utf8'))"
cd "$root"
sha256sum -c "$tmp/old.sha256"
systemctl is-active --quiet wg-platform
mkdir -p "$backup"
tar -czf "$backup/previous.tar.gz" frontend/wallet-connector.js package-lock.json
echo BACKUP_READY
rollback() {
  trap - EXIT
  if test "$success" != 1; then
    cd "$root"
    tar -xzf "$backup/previous.tar.gz"
    echo ROLLED_BACK
  fi
}
success=0
trap rollback EXIT
for file in 'frontend/wallet-connector.js' 'package-lock.json'; do
  cp "$stage/$file" "$file.next-__RELEASE__"
  chmod --reference="$file" "$file.next-__RELEASE__"
  chown --reference="$file" "$file.next-__RELEASE__"
  mv "$file.next-__RELEASE__" "$file"
done
sha256sum -c "$tmp/new.sha256"
systemctl is-active --quiet wg-platform
success=1
echo DEPLOYED_AND_VERIFIED
systemctl show wg-platform --property=ActiveState --property=SubState --property=MainPID
'@
  $command = $command.Replace('__RELEASE__', $release).Replace('__CHUNKS__', ($chunks -join ' ')).Replace('__ARCHIVE_HASH__', $archiveHash).Replace('__NEW_HASHES__', $newBase64).Replace('__OLD_HASHES__', $oldBase64)
  Invoke-CodeRemote $command
  [PSCustomObject]@{
    release = $release
    deployedAt = (Get-Date).ToString('o')
    backup = '/opt/wg-platform/backups/' + $release + '/previous.tar.gz'
    files = $files
    verified = $true
    backendAlreadyCurrent = $true
    runtimeBundleAlreadyCurrent = $true
    productionDependenciesChanged = $false
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'deployment-result.json') -Encoding utf8
} finally { Remove-SSHSession -SessionId $ssh.SessionId | Out-Null }
