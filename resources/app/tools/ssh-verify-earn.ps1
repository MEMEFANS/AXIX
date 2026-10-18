$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_cred.ps1"
$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 120
$sh = @'
echo "--- index.html version tag:"
curl -s http://127.0.0.1:8082/index.html | grep -o 'earn.js?v=[^"]*'
echo "--- ACT_RETRY_KEY occurrences in live earn.js:"
grep -c ACT_RETRY_KEY /opt/wg-platform/public/js/earn.js
echo "--- retryPendingActivation present:"
grep -c retryPendingActivation /opt/wg-platform/public/js/earn.js
echo "--- md5 live vs manifest check:"
md5sum /opt/wg-platform/public/js/earn.js | cut -d" " -f1
'@
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sh))
$cmd = "echo $b64 | base64 -d | bash"
$r = Invoke-SSHCommand -SessionId $ssh.SessionId -Command $cmd -TimeOut 60
Write-Output $r.Output
if ($r.Error) { Write-Output $r.Error }
Remove-SSHSession -SessionId $ssh.SessionId | Out-Null
