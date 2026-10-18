$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Mode = 'check'
if ($args.Count -gt 0) { $Mode = $args[0] }
$baseDir = $PSScriptRoot
if (-not $baseDir) { $baseDir = (Get-Location).Path }
. "$baseDir/_cred.ps1"

$localFile = $baseDir + '\leakfix.mjs'
$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 60
$sid = $ssh.SessionId

# chunked upload to avoid single-command length limit (ASCII comments only)
$b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($localFile))
$chunkSize = 40000
$totalChunks = [Math]::Ceiling($b64.Length / $chunkSize)
$tmpB64 = '/opt/wg-platform/leakfix.b64'
$first = $b64.Substring(0, [Math]::Min($chunkSize, $b64.Length))
$null = Invoke-SSHCommand -SessionId $sid -Command ("printf '%s' '$first' > " + $tmpB64) -TimeOut 30
for ($i = 1; $i -lt $totalChunks; $i++) {
    $start = $i * $chunkSize
    $len = [Math]::Min($chunkSize, $b64.Length - $start)
    $chunk = $b64.Substring($start, $len)
    $null = Invoke-SSHCommand -SessionId $sid -Command ("printf '%s' '$chunk' >> " + $tmpB64) -TimeOut 30
}
Write-Host "uploaded $totalChunks chunks ($($b64.Length) b64 chars)"
$r0 = Invoke-SSHCommand -SessionId $sid -Command "base64 -d $tmpB64 > /opt/wg-platform/scripts/leakfix.mjs && rm -f $tmpB64 && md5sum /opt/wg-platform/scripts/leakfix.mjs" -TimeOut 60
$r0.Output | ForEach-Object { Write-Output $_ }
Write-Host ("local md5=" + (Get-FileHash -Algorithm MD5 -Path $localFile).Hash.ToLower())

$cmd = "cd /opt/wg-platform && node scripts/leakfix.mjs $Mode 2>&1 | grep -v ExperimentalWarning | grep -v trace-warnings; rm -f /opt/wg-platform/scripts/leakfix.mjs"
$r = Invoke-SSHCommand -SessionId $sid -Command $cmd -TimeOut 300
$r.Output | ForEach-Object { Write-Output $_ }
if ($r.Error) { $r.Error | ForEach-Object { Write-Output $_ } }
Remove-SSHSession -SessionId $sid | Out-Null
