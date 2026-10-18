$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$baseDir = $PSScriptRoot
if (-not $baseDir) { $baseDir = (Get-Location).Path }
. "$baseDir/_cred.ps1"

$appRoot = 'C:\Users\cy020\Desktop\WG-Grid-Studio-' + ([char]0x5B8C + [char]0x6574 + [char]0x6210 + [char]0x4EA4 + [char]0x8D26 + [char]0x672C) + '\resources\app'
$tag = 'reconcile-20261014'
$files = @('src/a-token-activation-service.js', 'src/server.js', 'public/js/earn.js')

$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 60
$sid = $ssh.SessionId

foreach ($rel in $files) {
  $local = Join-Path $appRoot $rel
  $remote = "$remoteRoot/$rel"
  $md5Local = (Get-FileHash -Algorithm MD5 $local).Hash.ToLower()
  $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($local))
  Invoke-SSHCommand -SessionId $sid -Command "cp $remote ${remote}.bak-$tag 2>/dev/null; rm -f /tmp/_up.b64" -TimeOut 30 | Out-Null
  $chunkSize = 40000
  $totalChunks = [Math]::Ceiling($b64.Length / $chunkSize)
  $first = $b64.Substring(0, [Math]::Min($chunkSize, $b64.Length))
  Invoke-SSHCommand -SessionId $sid -Command "printf '%s' '$first' > /tmp/_up.b64" -TimeOut 60 | Out-Null
  for ($i = 1; $i -lt $totalChunks; $i++) {
    $start = $i * $chunkSize
    $len = [Math]::Min($chunkSize, $b64.Length - $start)
    $chunk = $b64.Substring($start, $len)
    $r = Invoke-SSHCommand -SessionId $sid -Command "printf '%s' '$chunk' >> /tmp/_up.b64" -TimeOut 60
    if ($r.ExitStatus -ne 0) { throw "chunk upload failed: $rel chunk $i" }
  }
  $r = Invoke-SSHCommand -SessionId $sid -Command "base64 -d /tmp/_up.b64 > $remote && md5sum $remote" -TimeOut 90
  $remoteMd5 = ($r.Output | Select-Object -First 1).Split(' ')[0].Trim().ToLower()
  if ($remoteMd5 -ne $md5Local) { throw "MD5 mismatch $rel local=$md5Local remote=$remoteMd5" }
  Write-Output "$rel MD5_OK ($totalChunks chunks)"
}
Invoke-SSHCommand -SessionId $sid -Command "rm -f /tmp/_up.b64" -TimeOut 20 | Out-Null

Write-Output '--- restart ---'
$r2 = Invoke-SSHCommand -SessionId $sid -Command "systemctl restart wg-platform && sleep 4 && systemctl is-active wg-platform" -TimeOut 120
$r2.Output | ForEach-Object { Write-Output $_ }

Write-Output '--- reconcile cursor row ---'
$r3 = Invoke-SSHCommand -SessionId $sid -Command "sleep 3; grep -ac a_token_activation_reconcile_v1 /opt/wg-platform/wg-platform.sqlite" -TimeOut 60
$r3.Output | ForEach-Object { Write-Output $_ }

Write-Output '--- recent journal ---'
$r4 = Invoke-SSHCommand -SessionId $sid -Command "journalctl -u wg-platform -n 25 --no-pager" -TimeOut 90
$r4.Output | ForEach-Object { Write-Output $_ }

Remove-SSHSession -SessionId $sid | Out-Null
