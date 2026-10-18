$ErrorActionPreference='Stop'
Import-Module Posh-SSH
$appRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../resources/app'))
. (Join-Path $appRoot 'tools/_cred.ps1')
$archive=Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'mobile-wallet-*.tar.gz' | Sort-Object Name -Descending | Select-Object -First 1
$release=$archive.Name -replace '\.tar\.gz$',''
if ($release -notmatch '^mobile-wallet-\d{8}-\d{6}$') { throw 'Invalid staged release name' }
$manifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'deploy-manifest.json') -Raw | ConvertFrom-Json
$files=@($manifest.PSObject.Properties.Name)
$hashLines=@()
foreach($file in $files){
  $hash=(Get-FileHash -LiteralPath (Join-Path $appRoot $file) -Algorithm SHA256).Hash.ToLower()
  if($hash -ne $manifest.$file){throw ('Local release has changed: '+$file)}
  $hashLines+=($hash+'  '+$file)
}
$hashBase64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($hashLines -join "`n")+"`n"))
$fileList=($files | ForEach-Object { "'$_'" }) -join ' '
$command=@'
set -eu
stage='/tmp/__RELEASE__/stage'
backup='/opt/wg-platform/backups/__RELEASE__'
cd "$stage"
printf '%s' '__HASHES__' | base64 -d > manifest.sha256
sha256sum -c manifest.sha256
for file in __FILES__; do case "$file" in *.js) node --check "$file";; esac; done
cd /opt/wg-platform
mkdir -p "$backup"
if ! test -f "$backup/previous.tar.gz"; then
  for file in __FILES__; do if test -f "$file"; then printf '%s\n' "$file"; fi; done > "$backup/existing-files.txt"
  tar -czf "$backup/previous.tar.gz" -T "$backup/existing-files.txt"
fi
echo BACKUP_READY
for file in __FILES__; do
  cp -p "$stage/$file" "$file.next-__RELEASE__"
  mv "$file.next-__RELEASE__" "$file"
done
sha256sum -c "$stage/manifest.sha256"
echo DEPLOYED_AND_VERIFIED
'@
# The entry page is switched last so all of its versioned assets are already available.
$orderedFiles=@($files | Where-Object {$_ -ne 'public/index.html'})+@('public/index.html')
$fileList=($orderedFiles | ForEach-Object { "'$_'" }) -join ' '
$command=$command.Replace('__RELEASE__',$release).Replace('__HASHES__',$hashBase64).Replace('__FILES__',$fileList)
$ssh=New-SSHSession -ComputerName $IP -Credential $cred -ErrorOnUntrusted -ConnectionTimeout 25
try{
  $result=Invoke-SSHCommand -SessionId $ssh.SessionId -Command $command -TimeOut 90
  Write-Output $result.Output
  if($result.ExitStatus -ne 0){throw ('Finalization failed: '+($result.Error -join ' '))}
  [PSCustomObject]@{release=$release;backup=('/opt/wg-platform/backups/'+$release);files=$orderedFiles;verified=$true} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'deployment-result.json') -Encoding utf8
}finally{Remove-SSHSession -SessionId $ssh.SessionId | Out-Null}
