param([Parameter(Mandatory=$true)][string]$PythonFile,[Parameter(Mandatory=$true)][string]$ResultFile,[ValidateRange(10,240)][int]$TimeoutSeconds=120)
$ErrorActionPreference = 'Stop'
Import-Module Posh-SSH
. "$PSScriptRoot/../../resources/app/tools/_cred.ps1"
$source = (Resolve-Path -LiteralPath $PythonFile).Path
$resultPath = [IO.Path]::GetFullPath($ResultFile)
$resultFolder = [IO.Path]::GetDirectoryName($resultPath)
$resultName = [IO.Path]::GetFileName($resultPath)
if ($resultName -notmatch '^[A-Za-z0-9._-]+$') { throw 'Result filename contains unsupported characters' }
$remoteStage = '/tmp/wg-admin-speed-' + [Guid]::NewGuid().ToString('N')
$ssh = New-SSHSession -ComputerName $IP -Credential $cred -ErrorOnUntrusted -ConnectionTimeout 90
$sftp = $null
try {
  $created = Invoke-SSHCommand -SessionId $ssh.SessionId -Command "mkdir -m 700 '$remoteStage'" -TimeOut 60
  if ($created.ExitStatus -ne 0) { throw 'Remote staging failed' }
  $sftp = New-SFTPSession -ComputerName $IP -Credential $cred -ErrorOnUntrusted -ConnectionTimeout 90
  Set-SFTPItem -SessionId $sftp.SessionId -Path $source -Destination $remoteStage | Out-Null
  $scriptName = [IO.Path]::GetFileName($source)
  if ($scriptName -notmatch '^[A-Za-z0-9._-]+$') { throw 'Script filename contains unsupported characters' }
  $command = "umask 077; timeout $($TimeoutSeconds)s python3 '$remoteStage/$scriptName' > '$remoteStage/$resultName'"
  $checked = Invoke-SSHCommand -SessionId $ssh.SessionId -Command $command -TimeOut ($TimeoutSeconds+15)
  if ($checked.ExitStatus -ne 0) { throw ('Remote script failed: ' + ($checked.Error -join ' ')) }
  Get-SFTPItem -SessionId $sftp.SessionId -Path "$remoteStage/$resultName" -Destination $resultFolder -Force | Out-Null
  $saved = Get-Item -LiteralPath $resultPath
  Write-Output ("Saved {0} bytes to {1}" -f $saved.Length,$ResultFile)
} finally {
  if ($sftp) { Remove-SFTPSession -SessionId $sftp.SessionId | Out-Null }
  Remove-SSHSession -SessionId $ssh.SessionId | Out-Null
}
