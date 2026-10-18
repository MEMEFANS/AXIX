param([Parameter(Mandatory=$true)][string]$PythonFile,[Parameter(Mandatory=$true)][string]$ResultFile,[ValidateRange(10,120)][int]$TimeoutSeconds=45)
$ErrorActionPreference = 'Stop'
Import-Module Posh-SSH
. "$PSScriptRoot/../../resources/app/tools/_cred.ps1"
$code = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $PythonFile))
$code64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($code))
$command = "printf '%s' '$code64' | base64 -d | timeout $($TimeoutSeconds)s python3"
$ssh = New-SSHSession -ComputerName $IP -Credential $cred -ErrorOnUntrusted -ConnectionTimeout 25
try {
  if ($code64.Length -gt 48000) {
    $remoteStage = '/tmp/wg-incident-run-' + [Guid]::NewGuid().ToString('N')
    $mkdir = Invoke-SSHCommand -SessionId $ssh.SessionId -Command "mkdir '$remoteStage'" -TimeOut 15
    if ($mkdir.ExitStatus -ne 0) { throw 'Unable to stage incident script' }
    $parts = @()
    for ($offset=0; $offset -lt $code64.Length; $offset+=32768) {
      $part = "$remoteStage/part-$($parts.Count)"
      $chunk = $code64.Substring($offset,[Math]::Min(32768,$code64.Length-$offset))
      $write = Invoke-SSHCommand -SessionId $ssh.SessionId -Command "printf '%s' '$chunk' > '$part'" -TimeOut 15
      if ($write.ExitStatus -ne 0) { throw 'Unable to upload incident script chunk' }
      $parts += "'$part'"
    }
    $command = "cat $($parts -join ' ') | base64 -d | timeout $($TimeoutSeconds)s python3"
  }
  $r = Invoke-SSHCommand -SessionId $ssh.SessionId -Command $command -TimeOut ($TimeoutSeconds+10)
  if ($r.ExitStatus -ne 0) { throw ($r.Error -join ' ') }
  $output = $r.Output -join "`n"
  [IO.File]::WriteAllText([IO.Path]::GetFullPath($ResultFile), $output, [Text.UTF8Encoding]::new($false))
  Write-Output ("Saved {0} bytes to {1}" -f [Text.Encoding]::UTF8.GetByteCount($output), $ResultFile)
} finally {
  Remove-SSHSession -SessionId $ssh.SessionId | Out-Null
}
