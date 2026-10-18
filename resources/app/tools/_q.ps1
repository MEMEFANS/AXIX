$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$baseDir = $PSScriptRoot
if (-not $baseDir) { $baseDir = (Get-Location).Path }
. "$baseDir/_cred.ps1"

$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 60
$sid = $ssh.SessionId

$cmd = @'
LOG=/opt/wg-platform/logs/server.stdout.log
ERR=/opt/wg-platform/logs/server.stderr.log
echo "=== log meta ==="
ls -la $LOG $ERR
head -1 $LOG
tail -1 $LOG
echo "=== restart timeline (Started) ==="
journalctl -u wg-platform --since "2026-10-12 00:00" --no-pager 2>/dev/null | grep "Started wg-platform"
echo "=== leak wallets in app log (count) ==="
grep -icE "5db39dff|af188184|d9883ad2" $LOG
echo "=== leak tx in app log (count) ==="
grep -icE "d10f07a16b208ac8|689c73fe8f8f598f|cea4c0337fa89bf8" $LOG
echo "=== last activate lines ==="
grep -aE "activation|activate|ACTIVATION" $LOG | tail -20
echo "=== last error lines ==="
grep -aiE "error|ECONN|ETIMEDOUT|EPIPE|unhandled|throw" $LOG | tail -25
echo "=== stderr tail ==="
tail -30 $ERR
'@
$r = Invoke-SSHCommand -SessionId $sid -Command $cmd -TimeOut 200
$r.Output | ForEach-Object { Write-Output $_ }
if ($r.Error) { $r.Error | ForEach-Object { Write-Output $_ } }
Remove-SSHSession -SessionId $sid | Out-Null
