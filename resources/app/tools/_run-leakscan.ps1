$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Hours = 24
$baseDir = $PSScriptRoot
if (-not $baseDir) { $baseDir = (Get-Location).Path }
. "$baseDir/_cred.ps1"

$launch = @'
pkill -f leakscan.mjs
sleep 1
cd /opt/wg-platform
setsid nohup node scripts/leakscan.mjs HH > /tmp/leakscan.log 2>&1 < /dev/null &
sleep 2
echo STARTED
tail -n 5 /tmp/leakscan.log
'@
$launch = $launch.Replace('HH', [string]$Hours)

$localFile = $baseDir + '\leakscan.mjs'
Write-Host "localFile=$localFile exists=$(Test-Path $localFile)"

$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 60
$sid = $ssh.SessionId

$b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($localFile))
$chunkSize = 40000
$totalChunks = [Math]::Ceiling($b64.Length / $chunkSize)
$tmpB64 = '/opt/wg-platform/leakscan.b64'
$first = $b64.Substring(0, [Math]::Min($chunkSize, $b64.Length))
$null = Invoke-SSHCommand -SessionId $sid -Command ("printf '%s' '$first' > " + $tmpB64) -TimeOut 30
for ($i = 1; $i -lt $totalChunks; $i++) {
    $start = $i * $chunkSize
    $len = [Math]::Min($chunkSize, $b64.Length - $start)
    $chunk = $b64.Substring($start, $len)
    $null = Invoke-SSHCommand -SessionId $sid -Command ("printf '%s' '$chunk' >> " + $tmpB64) -TimeOut 30
}
Write-Host "uploaded $totalChunks chunks ($($b64.Length) b64 chars)"
$r0 = Invoke-SSHCommand -SessionId $sid -Command "base64 -d $tmpB64 > /opt/wg-platform/scripts/leakscan.mjs && rm -f $tmpB64 && md5sum /opt/wg-platform/scripts/leakscan.mjs" -TimeOut 60
$r0.Output | ForEach-Object { Write-Output $_ }
Write-Host ("local md5=" + (Get-FileHash -Algorithm MD5 -Path $localFile).Hash.ToLower())

$b64s = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($launch))
$cmd = "echo '$b64s' | base64 -d > /tmp/launch_leak.sh && bash /tmp/launch_leak.sh"
$r2 = Invoke-SSHCommand -SessionId $sid -Command $cmd -TimeOut 90
$r2.Output | ForEach-Object { Write-Output $_ }
if ($r2.Error) { $r2.Error | ForEach-Object { Write-Output $_ } }
Remove-SSHSession -SessionId $sid | Out-Null
