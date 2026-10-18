param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. "$PSScriptRoot/_cred.ps1"

$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 60
$sid = $ssh.SessionId
Start-Sleep -Seconds 40
$shText = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot '_verify-8b2a.sh')) -replace "`r`n", "`n"
$b64 = [System.Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($shText))
$r = Invoke-SSHCommand -SessionId $sid -Command "echo $b64 | base64 -d > /tmp/_v8.sh && bash /tmp/_v8.sh 2>&1; rm -f /tmp/_v8.sh" -TimeOut 180
$r.Output | ForEach-Object { Write-Output $_ }
if ($r.Error) { $r.Error | ForEach-Object { Write-Output $_ } }
Remove-SSHSession -SessionId $sid | Out-Null
