# Deploy earn.js + index.html via pscp.exe using -hostkey to bypass cache prompt.
# Gets the server's RSA host key as hex blob via Posh-SSH, passes it to pscp -hostkey.
# Transfers CR-stripped temp copies, then moves + MD5 verifies via SSH.
param()
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_cred.ps1"
$LocalApp = 'c:\Users\cy020\Desktop\WG-Grid-Studio-' + [char]0x5B8C + [char]0x6574 + [char]0x6210 + [char]0x4EA4 + [char]0x8D26 + [char]0x672C + '\resources\app'

$pscp = Join-Path $PSScriptRoot 'pscp.exe'
$user  = $cred.GetNetworkCredential().UserName
$pass  = $cred.GetNetworkCredential().Password

$files = @(
  @{ rel = 'public/js/earn.js';  dst = '/opt/wg-platform/public/js/earn.js' }
  @{ rel = 'public/index.html';  dst = '/opt/wg-platform/public/index.html' }
)

function Get-CrStrippedMd5([string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $ms = New-Object System.IO.MemoryStream
  foreach ($b in $bytes) { if ($b -ne 13) { [void]$ms.WriteByte($b) } }
  $md5 = [System.Security.Cryptography.MD5]::Create()
  $hb = $md5.ComputeHash($ms.ToArray())
  $ms.Dispose()
  return ([System.BitConverter]::ToString($hb) -replace '-','').ToLower()
}

# --- Step 1: Get host key hex blob from server via Posh-SSH ---
Write-Output '[1] Connect SSH to fetch host key...'
$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 120
$sid = $ssh.SessionId
$py = "import base64; line=open('/etc/ssh/ssh_host_rsa_key.pub').read().split(); print(base64.b64decode(line[1]).hex())"
$r = Invoke-SSHCommand -SessionId $sid -Command "python3 -c `"$py`"" -TimeOut 30
$hexBlob = ($r.Output -join '').Trim()
if ($hexBlob.Length -lt 100) {
  Remove-SSHSession -SessionId $sid | Out-Null
  throw "Failed to get host key hex blob (len=$($hexBlob.Length))"
}
$hostKey = "0x$hexBlob"
Write-Output "    hostkey hexlen=$($hexBlob.Length) total_len=$($hostKey.Length)"

# --- Step 2: Create CR-stripped temp copies locally ---
Write-Output '[2] Create CR-stripped temp copies...'
$tempDir = Join-Path $env:TEMP 'wg-deploy-earn-fix'
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
New-Item -Path $tempDir -ItemType Directory | Out-Null
$tempFiles = @()
foreach ($f in $files) {
  $local = Join-Path $LocalApp ($f.rel -replace '/','\')
  $name  = [System.IO.Path]::GetFileName($f.dst)
  $temp  = Join-Path $tempDir $name
  $bytes = [System.IO.File]::ReadAllBytes($local)
  $clean = New-Object System.IO.MemoryStream
  foreach ($b in $bytes) { if ($b -ne 13) { [void]$clean.WriteByte($b) } }
  [System.IO.File]::WriteAllBytes($temp, $clean.ToArray())
  $clean.Dispose()
  $localMd5 = Get-CrStrippedMd5 $local
  $tempFiles += @{ temp = $temp; dst = $f.dst; name = $name; localMd5 = $localMd5; size = (Get-Item $temp).Length }
  Write-Output "    $name : $($tempFiles[-1].size) bytes, CR-stripped MD5=$localMd5"
}

# --- Step 3: pscp upload with -hostkey to bypass cache prompt ---
Write-Output '[3] Upload via pscp.exe (-hostkey bypass)...'
foreach ($tf in $tempFiles) {
  $remoteTmp = "/tmp/_dep_$($tf.name)"
  Write-Output "    pscp $($tf.name) ($($tf.size)B) -> $remoteTmp"
  $out = & $pscp -hostkey $hostKey -batch -pw $pass -P 22 $tf.temp "${user}@${IP}:${remoteTmp}" 2>&1
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    Write-Output "    [ERROR] pscp exit=$code"
    Write-Output "    $($out -join "`n")"
  } else {
    Write-Output "    [OK] pscp exit=0"
  }
}

# --- Step 4: Move files into place + verify MD5 via SSH ---
Write-Output '[4] Move + MD5 verify via SSH...'
$allOk = $true
foreach ($tf in $tempFiles) {
  $remoteTmp = "/tmp/_dep_$($tf.name)"
  $dst = $tf.dst
  $mvCmd = "cp $remoteTmp $dst && rm -f $remoteTmp && echo MOVED"
  $r = Invoke-SSHCommand -SessionId $sid -Command $mvCmd -TimeOut 30
  Write-Output "    $($tf.name): $($r.Output -join ' ')"
  $md5Cmd = "tr -d '\r' < $dst | md5sum | cut -d' ' -f1"
  $r = Invoke-SSHCommand -SessionId $sid -Command $md5Cmd -TimeOut 30
  $remoteMd5 = ($r.Output -join '').Trim().ToLower()
  if ($remoteMd5 -eq $tf.localMd5) {
    Write-Output "    [OK] $($tf.name) MD5 match: $remoteMd5"
  } else {
    Write-Output "    [FAIL] $($tf.name) local=$($tf.localMd5) remote=$remoteMd5"
    $allOk = $false
  }
}

# --- Cleanup ---
Remove-SSHSession -SessionId $sid | Out-Null
Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue

if ($allOk) {
  Write-Output "[DONE] Both files deployed + MD5 verified. Ctrl+F5 to load earn.js?v=20260928-activation-local-1"
} else {
  Write-Output "[ERROR] MD5 mismatch - deployment NOT verified. Check errors above."
  exit 1
}
