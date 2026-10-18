$ErrorActionPreference = 'Stop'
Import-Module Posh-SSH
. (Join-Path $PSScriptRoot '../../resources/app/tools/_cred.ps1')
$ssh = New-SSHSession -ComputerName $IP -Credential $cred -ErrorOnUntrusted -ConnectionTimeout 25
try {
  $local = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'local-manifest.json') -Raw | ConvertFrom-Json
  $paths = @($local.PSObject.Properties.Name) | ConvertTo-Json -Compress
  $pathsBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($paths))
  $python = @'
import os, json, hashlib
import base64, stat
root='/opt/wg-platform'
manifest={}
text_ext={'.js','.mjs','.cjs','.json','.html','.css','.svg','.sol','.md'}
def add(rel):
    full=os.path.join(root,rel)
    if not stat.S_ISREG(os.stat(full).st_mode): raise RuntimeError('Not a regular code file: '+rel)
    with open(full,'rb') as f: body=f.read()
    if os.path.splitext(rel)[1] in text_ext: body=body.replace(b'\r',b'')
    manifest[rel]={'sha256':hashlib.sha256(body).hexdigest(),'bytes':len(body)}
for name in json.loads(base64.b64decode('__PATHS__')): add(name)
print(json.dumps(manifest))
'@
  $python = $python.Replace('__PATHS__', $pathsBase64)
  $pythonBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($python))
  $command = "set -eu; systemctl is-active --quiet wg-platform; printf '%s' '$pythonBase64' | base64 -d | timeout 30s python3"
  $r = Invoke-SSHCommand -SessionId $ssh.SessionId -Command $command -TimeOut 50
  if ($r.ExitStatus -ne 0) { throw ('Remote verification failed: ' + ($r.Error -join ' ')) }
  ($r.Output -join "`n") | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'post-deploy-remote-manifest.json') -Encoding utf8
  $remote = ($r.Output -join "`n") | ConvertFrom-Json
  $mismatches = @()
  foreach ($entry in $local.PSObject.Properties) {
    if ($remote.($entry.Name).sha256 -ne $entry.Value.sha256) { $mismatches += $entry.Name }
  }
  if ($mismatches.Count) { throw ('Remote code mismatches: ' + ($mismatches -join ', ')) }
  [PSCustomObject]@{checkedAt=(Get-Date).ToString('o');matchedFiles=@($local.PSObject.Properties).Count;allLocalCodeMatches=$true;serviceActive=$true} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'server-verification.json') -Encoding utf8
  Write-Output ('PASS: server active; all ' + @($local.PSObject.Properties).Count + ' local code files match production')
} finally { Remove-SSHSession -SessionId $ssh.SessionId | Out-Null }
