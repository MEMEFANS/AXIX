$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. "$PSScriptRoot/_cred.ps1"

$localFile = Join-Path $PSScriptRoot '_oldtest.sh'
$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 60
$sid = $ssh.SessionId
$sh = ([System.IO.File]::ReadAllText($localFile, [System.Text.Encoding]::UTF8)) -replace "`r`n", "`n"
$b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($sh))
$cmd = "echo '$b64' | base64 -d > /tmp/oldtest.sh && bash /tmp/oldtest.sh 2>&1; rm -f /tmp/oldtest.sh"
$r = Invoke-SSHCommand -SessionId $sid -Command $cmd -TimeOut 300
$r.Output | ForEach-Object { Write-Output $_ }
if ($r.Error) { $r.Error | ForEach-Object { Write-Output $_ } }
Remove-SSHSession -SessionId $sid | Out-Null
