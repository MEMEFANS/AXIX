param([string]$Cmd = 'echo hello')

Import-Module Posh-SSH
. 'c:\Users\cy020\Desktop\WG-Grid-Studio-完整成交账本\resources\app\tools\_cred.ps1'

$session = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 120
$sid = $session.SessionId
Write-Output "=== SESSION $sid ESTABLISHED ==="

$result = Invoke-SSHCommand -SessionId $sid -Command $Cmd -TimeOut 60
Write-Output "=== EXIT CODE: $($result.ExitStatus) ==="
Write-Output $result.Output
