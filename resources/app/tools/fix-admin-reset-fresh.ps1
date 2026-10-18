# Deploy rebuildAll fresh-start fix + clear klines user just backfilled via admin reset.
$ErrorActionPreference = 'Stop'
Import-Module Posh-SSH
. "$PSScriptRoot/_cred.ps1"
$localRoot = Split-Path $PSScriptRoot -Parent
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

$ssh = $null
for ($i = 1; $i -le 6; $i++) {
  try { $ssh = New-SSHSession -ComputerName $server -Credential $cred -AcceptKey -Force -ConnectionTimeout 25; break }
  catch { Start-Sleep -Seconds (3 * $i) }
}
if (-not $ssh) { throw 'SSH failed' }

function Invoke-Remote([string]$cmdStr, [int]$timeoutSec = 30) {
  for ($try = 1; $try -le 4; $try++) {
    try { return Invoke-SSHCommand -SessionId $script:ssh.SessionId -Command $cmdStr -TimeOut $timeoutSec }
    catch {
      Write-Host "retry $try ..."; Start-Sleep -Seconds (2 * $try)
      Get-SSHSession | Remove-SSHSession | Out-Null
      $script:ssh = $null
      for ($i = 1; $i -le 6; $i++) {
        try { $script:ssh = New-SSHSession -ComputerName $server -Credential $cred -AcceptKey -Force -ConnectionTimeout 25; break }
        catch { Start-Sleep -Seconds (3 * $i) }
      }
      if (-not $script:ssh) { throw 'SSH reconnect failed' }
    }
  }
}

function Send-B64([string]$content, [string]$remotePath) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($content))
  $tmp = "$remotePath.b64"
  $chunkSize = 50000
  $n = [Math]::Ceiling($b64.Length / $chunkSize)
  $null = Invoke-Remote "printf '%s' '$($b64.Substring(0,[Math]::Min($chunkSize,$b64.Length)))' > $tmp"
  for ($i = 1; $i -lt $n; $i++) {
    $start = $i * $chunkSize
    $null = Invoke-Remote "printf '%s' '$($b64.Substring($start, [Math]::Min($chunkSize, $b64.Length - $start)))' >> $tmp"
  }
  $null = Invoke-Remote "base64 -d $tmp > $remotePath && rm -f $tmp"
  Write-Host "uploaded: $remotePath ($n chunks)"
}

function Send-FileB64([string]$localPath, [string]$remotePath) {
  $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($localPath))
  $tmp = "$remotePath.b64tmp"
  $chunkSize = 50000
  $n = [Math]::Ceiling($b64.Length / $chunkSize)
  $null = Invoke-Remote "printf '%s' '$($b64.Substring(0,[Math]::Min($chunkSize,$b64.Length)))' > $tmp"
  for ($i = 1; $i -lt $n; $i++) {
    $start = $i * $chunkSize
    $null = Invoke-Remote "printf '%s' '$($b64.Substring($start, [Math]::Min($chunkSize, $b64.Length - $start)))' >> $tmp"
  }
  $null = Invoke-Remote "base64 -d $tmp > $remotePath && rm -f $tmp"
  Write-Host "uploaded: $(Split-Path $localPath -Leaf) ($n chunks)"
}

$clearJs = @'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/wg-platform/wg-platform.sqlite');
const before = db.prepare('SELECT period, MIN(time) AS earliest, COUNT(*) AS c FROM a_token_klines GROUP BY period').all();
console.log('BEFORE', JSON.stringify(before.map(r => ({ p: r.period, c: r.c, earliestUTC: new Date(r.earliest*1000).toISOString() }))));
console.log('DELETED', db.prepare('DELETE FROM a_token_klines').run().changes);
const srow = db.prepare('SELECT payload_json FROM service_settings WHERE setting_key=?').get('a_token_kline_settings');
if (srow) {
  const s = JSON.parse(srow.payload_json);
  s.daily = null;
  db.prepare('UPDATE service_settings SET payload_json=?, updated_at=? WHERE setting_key=?').run(JSON.stringify(s), Date.now(), 'a_token_kline_settings');
  console.log('DAILY_ANCHOR_NULLED');
}
console.log('CLEAR_DONE');
'@

try {
  Write-Host '=== [1/5] backup ==='
  $r = Invoke-Remote "mkdir -p /opt/wg-platform/backups/kline-adminreset-$stamp/src && cp /opt/wg-platform/wg-platform.sqlite /opt/wg-platform/backups/kline-adminreset-$stamp/ && cp /opt/wg-platform/src/a-token-kline-service.js /opt/wg-platform/backups/kline-adminreset-$stamp/src/ && echo BACKUP_OK"
  Write-Host ($r.Output -join "`n")

  Write-Host '=== [2/5] stop + upload ==='
  $r = Invoke-Remote "systemctl stop wg-platform && sleep 2 && echo STOPPED"
  Write-Host ($r.Output -join "`n")
  Send-FileB64 (Join-Path $localRoot 'src\a-token-kline-service.js') '/opt/wg-platform/src/a-token-kline-service.js'
  Send-B64 $clearJs '/opt/wg-platform/.clear-kline.cjs'
  $r = Invoke-Remote "cd /opt/wg-platform && node --check src/a-token-kline-service.js 2>&1 && node --check .clear-kline.cjs 2>&1 && echo CHECK_OK"
  Write-Host ($r.Output -join "`n")
  if (($r.Output -join "`n") -notmatch 'CHECK_OK') { throw 'syntax check failed' }

  Write-Host '=== [3/5] clear old candles ==='
  $r = Invoke-Remote "cd /opt/wg-platform && node .clear-kline.cjs; rm -f .clear-kline.cjs" 60
  Write-Host ($r.Output -join "`n")
  if (($r.Output -join "`n") -notmatch 'CLEAR_DONE') { throw 'clear failed' }

  Write-Host '=== [4/5] start (ensureSeeded rebuilds 9.28 candles) ==='
  $r = Invoke-Remote "systemctl start wg-platform; sleep 9; systemctl is-active wg-platform"
  Write-Host ($r.Output -join "`n")

  Write-Host '=== [5/5] verify ==='
  $verify = @'
for p in 1m 5m 15m 1h 4h 1d; do
  curl -s "http://127.0.0.1:8082/api/a-token/kline?period=$p&limit=2000" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const cs=JSON.parse(d).candles;console.log('$p','count='+cs.length,'firstUTC='+new Date(cs[0].time*1000).toISOString(),'lastUTC='+new Date(cs[cs.length-1].time*1000).toISOString());});"
done
echo -n '9.28 BJ daystart='; date -d '2026-09-28 00:00:00 +0800' +%s
curl -s http://127.0.0.1:8082/api/a-token/pool | tr ',' '\n' | grep -a -m1 priceUsdt
echo VERIFY_DONE
'@
  Send-B64 $verify '/tmp/verify-kline.sh'
  $r = Invoke-Remote "bash /tmp/verify-kline.sh; rm -f /tmp/verify-kline.sh" 90
  Write-Host ($r.Output -join "`n")
  if (($r.Output -join "`n") -notmatch 'VERIFY_DONE') { throw 'verify failed' }
} finally {
  Get-SSHSession | Remove-SSHSession | Out-Null
}
