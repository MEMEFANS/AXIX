param()
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_cred.ps1"

$py = @'
import sqlite3, time
ADDR = '0x50ac7077c4bfe209ab2032923d326b93aed0d616'
db = sqlite3.connect('/opt/wg-platform/wg-platform.sqlite')
db.row_factory = sqlite3.Row
c = db.cursor()

def ts(ms):
    try: return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime((ms or 0)/1000))
    except: return ''

def metrics(w):
    u = c.execute('SELECT created_at FROM wallet_users WHERE lower(address)=?', (w,)).fetchone()
    reg = ts(u['created_at']) if u else ''
    dep = c.execute('SELECT COUNT(*) FROM deposits WHERE lower(wallet)=?', (w,)).fetchone()[0]
    od = c.execute('SELECT COUNT(*) FROM a_token_orders WHERE lower(wallet)=?', (w,)).fetchone()[0]
    tr = c.execute('SELECT COUNT(*) FROM a_token_trades WHERE lower(wallet)=?', (w,)).fetchone()[0]
    mn = c.execute('SELECT COUNT(*) FROM a_token_miners WHERE lower(wallet)=?', (w,)).fetchone()[0]
    return reg, dep, od, tr, mn

def emit(prefix, w, invitee):
    reg, dep, od, tr, mn = metrics(w)
    acts = list(c.execute('SELECT * FROM a_token_activations WHERE lower(wallet)=?', (w,)))
    if not acts:
        print('%s|%s|%s|%s|%s|%s|%s|%s|%d|%d|%d|%d|%s' % (prefix, w, '', '', '', '', '', reg, dep, od, tr, mn, invitee))
        return
    for a in acts:
        d = dict(a)
        print('%s|%s|%s|%s|%s|%s|%s|%s|%d|%d|%d|%d|%s' % (
            prefix, w, d.get('tx_hash') or '', d.get('block_number') or '',
            ts(d.get('confirmed_at') or d.get('created_at')),
            d.get('plan'), d.get('status'), reg, dep, od, tr, mn, invitee))

inv = set(r['wallet'].lower() for r in c.execute('SELECT wallet FROM platform_referral_links WHERE lower(referrer_wallet)=?', (ADDR,)))
srcs = set(r[0].lower() for r in c.execute('SELECT DISTINCT lower(from_wallet) FROM a_token_transfers WHERE lower(to_wallet)=?', (ADDR,)))
targets = sorted(inv | srcs)
print('COUNT|%d|%d|%d' % (len(inv), len(srcs), len(targets)))
for w in targets:
    emit('DATA', w, 'YES' if w in inv else 'NO')
emit('HUB', ADDR, '-')
'@

$bytes = [System.Text.Encoding]::UTF8.GetBytes(($py -replace "`r", ""))
$b64 = [System.Convert]::ToBase64String($bytes)

$ssh = New-SSHSession -ComputerName $IP -Credential $cred -ErrorOnUntrusted -ConnectionTimeout 120
$sid = $ssh.SessionId
Invoke-SSHCommand -SessionId $sid -Command "rm -f /tmp/_qrec.py.b64 /tmp/_qrec.py" -TimeOut 20 | Out-Null
for ($i = 0; $i -lt $b64.Length; $i += 40000) {
  $len = [Math]::Min(40000, $b64.Length - $i)
  Invoke-SSHCommand -SessionId $sid -Command "printf '%s' '$($b64.Substring($i,$len))' >> /tmp/_qrec.py.b64" -TimeOut 30 | Out-Null
}
$r = Invoke-SSHCommand -SessionId $sid -Command "base64 -d /tmp/_qrec.py.b64 > /tmp/_qrec.py && rm -f /tmp/_qrec.py.b64; (python3 /tmp/_qrec.py 2>&1 || python /tmp/_qrec.py 2>&1)" -TimeOut 240
Remove-SSHSession -SessionId $sid | Out-Null

$out = $r.Output
$count = ($out | Where-Object { $_ -like 'COUNT|*' } | Select-Object -First 1)
Write-Output "REMOTE $count"

$rows = New-Object System.Collections.Generic.List[string]
$rows.Add('category,address,tx_hash,block,plan,status,confirmed_at,registered_at,direct_invitee,deposits,orders,trades,miners')
$nData = 0
foreach ($line in $out) {
  if ($line -like 'DATA|*' -or $line -like 'HUB|*') {
    $p = $line -split '\|'
    # p: 0 prefix, 1 address, 2 tx, 3 block, 4 confirmedAt, 5 plan, 6 status, 7 reg, 8 dep, 9 orders, 10 trades, 11 miners, 12 invitee
    $cat = if ($p[0] -eq 'HUB') { 'collection-hub-0x50ac' }
           elseif ($p[12] -eq 'YES') { 'hub-invitee+sybil-source' }
           else { 'sybil-source' }
    $plan = if ($p[5] -eq '1') { '1-0.002BNB' } elseif ($p[5] -eq '2') { '2-0.05BNB' } else { '' }
    $rows.Add(($cat + ',' + $p[1] + ',' + $p[2] + ',' + $p[3] + ',' + $plan + ',' + $p[6] + ',' + $p[4] + ',' + $p[7] + ',' + $p[12] + ',' + $p[8] + ',' + $p[9] + ',' + $p[10] + ',' + $p[11]))
    if ($p[0] -eq 'DATA') { $nData++ }
  }
}
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$target = Join-Path $root 'flagged-wallets-20261014.csv'
[System.IO.File]::WriteAllText($target, ($rows -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Output "WROTE $target  dataRows=$nData  totalLines=$($rows.Count)"
foreach ($l in $rows[0..3]) { Write-Output $l }
