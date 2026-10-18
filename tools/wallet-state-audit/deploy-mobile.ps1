$ErrorActionPreference = 'Stop'
Import-Module Posh-SSH
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../resources/app'))
. (Join-Path $appRoot 'tools/_cred.ps1')
$release = 'mobile-wallet-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$files = @(
  'public/js/wallet.js', 'public/js/core.js', 'public/js/ai-managed.js', 'public/js/page-loader.js', 'public/js/assets.js',
  'public/js/earn.js', 'public/js/platform-client.js',
  'public/js/i18n.js', 'public/js/i18n-zh-en.js', 'public/js/i18n-extra.js',
  'public/vendor/wallet/connector.js', 'public/index.html'
)
$archive = Join-Path $PSScriptRoot ($release + '.tar.gz')
& tar -czf $archive -C $appRoot @files
if ($LASTEXITCODE -ne 0) { throw 'Archive creation failed' }
$manifest = @{}
foreach ($file in $files) { $manifest[$file] = (Get-FileHash -LiteralPath (Join-Path $appRoot $file) -Algorithm SHA256).Hash.ToLower() }
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'deploy-manifest.json') -Encoding utf8
$ssh = New-SSHSession -ComputerName $IP -Credential $cred -ErrorOnUntrusted -ConnectionTimeout 25
function Invoke-MobileRemote([string]$command) {
  $result = Invoke-SSHCommand -SessionId $ssh.SessionId -Command $command -TimeOut 45
  if ($result.ExitStatus -ne 0) { throw ('Remote command failed: ' + ($result.Error -join ' ')) }
  return $result.Output
}
try {
  $remoteTmp = '/tmp/' + $release
  $backup = '/opt/wg-platform/backups/' + $release
  Invoke-MobileRemote "mkdir -p '$remoteTmp'" | Out-Null
  $base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($archive))
  Invoke-MobileRemote ": > '$remoteTmp/package.b64'" | Out-Null
  for ($position=0; $position -lt $base64.Length; $position+=32768) {
    $chunk = $base64.Substring($position, [Math]::Min(32768, $base64.Length-$position))
    Invoke-MobileRemote "printf '%s' '$chunk' >> '$remoteTmp/package.b64'" | Out-Null
  }
  Invoke-MobileRemote "base64 -d '$remoteTmp/package.b64' > '$remoteTmp/package.tar.gz' && mkdir -p '$remoteTmp/stage' && tar -xzf '$remoteTmp/package.tar.gz' -C '$remoteTmp/stage'" | Out-Null
  foreach ($file in $files) {
    $actual = ((Invoke-MobileRemote "sha256sum '$remoteTmp/stage/$file'") -join ' ').Split(' ')[0]
    if ($actual -ne $manifest[$file]) { throw ('Staging checksum failed: '+$file) }
    if ($file.EndsWith('.js')) { Invoke-MobileRemote "node --check '$remoteTmp/stage/$file'" | Out-Null }
  }
  Write-Output ('STAGING_VERIFIED: '+$files.Count+' frontend files')
  $fileList = ($files | ForEach-Object { "'$_'" }) -join ' '
  $backupCommand = 'cd /opt/wg-platform && mkdir -p ''{0}'' && for file in {1}; do if test -f "$file"; then printf ''%s\n'' "$file"; fi; done > ''{0}/existing-files.txt'' && tar -czf ''{0}/previous.tar.gz'' -T ''{0}/existing-files.txt''' -f $backup,$fileList
  Invoke-MobileRemote $backupCommand | Out-Null
  Write-Output ('BACKUP: '+$backup+'/previous.tar.gz')
  # Switch the HTML entry last so new versioned resources exist before clients request them.
  foreach ($file in $files) {
    Invoke-MobileRemote "cp -p '$remoteTmp/stage/$file' '/opt/wg-platform/$file.new-$release' && mv '/opt/wg-platform/$file.new-$release' '/opt/wg-platform/$file'" | Out-Null
  }
  foreach ($file in $files) {
    $actual = ((Invoke-MobileRemote "sha256sum '/opt/wg-platform/$file'") -join ' ').Split(' ')[0]
    if ($actual -ne $manifest[$file]) { throw ('Production checksum failed: '+$file) }
  }
  [PSCustomObject]@{release=$release;backup=$backup;files=$files;verified=$true} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'deployment-result.json') -Encoding utf8
  Write-Output 'DEPLOYED: all frontend SHA256 checks passed; backend service unchanged'
} finally { Remove-SSHSession -SessionId $ssh.SessionId | Out-Null }
