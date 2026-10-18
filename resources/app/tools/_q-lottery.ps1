param()
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_cred.ps1"

$py = @'
import sqlite3, time, os, json, re
DB = '/opt/wg-platform/wg-platform.sqlite'
db = sqlite3.connect(DB); db.row_factory = sqlite3.Row; c = db.cursor()

def cols(t):
    return [d[1] for d in c.execute('PRAGMA table_info(' + t + ')')]
def ts(ms):
    try: return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime((ms or 0)/1000))
    except: return ''

print('=== lottery_wins columns ===')
print(cols('lottery_wins'))
print()
print('=== lottery_flows columns ===')
print(cols('lottery_flows'))
print()
print('=== lottery_accounts columns ===')
print(cols('lottery_accounts'))
print()

w = cols('lottery_wins')
sym = 'symbol' if 'symbol' in w else None
pz = 'prize_id' if 'prize_id' in w else ('prizeId' if 'prizeId' in w else None)
am = 'amount' if 'amount' in w else None
wa = 'wallet' if 'wallet' in w else None
ct = 'created_at' if 'created_at' in w else None

print('=== all wins grouped by prize/symbol ===')
q = 'SELECT %s, %s, COUNT(*), SUM(%s) FROM lottery_wins GROUP BY 1,2 ORDER BY 3 DESC' % (sym or "''", pz or "''", am or '0')
for r in c.execute(q):
    print('  symbol=%-6s prize=%-12s n=%-6s amount_sum=%s' % (r[0], r[1], r[2], r[3]))
print()

print('=== AIX wins detail ===')
n = 0; tot = 0.0
rows = c.execute("SELECT * FROM lottery_wins WHERE %s='AIX' OR %s='aix' ORDER BY %s" % (sym, pz, ct)).fetchall()
print('AIX win count = %d' % len(rows))
for r in rows:
    d = dict(r)
    n += 1
    try: tot += float(d.get(am) or 0)
    except: pass
    if n <= 25:
        print('  %s  wallet=%s  amount=%s  valueUsdt=%s  status=%s  claimedAt=%s' % (
            ts(d.get(ct)), d.get(wa), d.get(am), d.get('value_usdt') or d.get('valueUsdt'),
            d.get('status'), ts(d.get('claimed_at') or d.get('claimedAt'))))
print('AIX total amount = %.6f' % tot)
print()

print('=== current A balance of AIX winners (balances_json A / 1e18) ===')
seen = set()
for r in rows[:30]:
    d = dict(r); wl = (d.get(wa) or '').lower()
    if wl in seen: continue
    seen.add(wl)
    u = c.execute('SELECT balances_json, created_at FROM wallet_users WHERE lower(address)=?', (wl,)).fetchone()
    a = None
    if u:
        try: a = int((json.loads(u['balances_json'] or '{}') or {}).get('A') or 0) / 1e18
        except Exception as e: a = 'parse-err ' + str(e)
    mn = c.execute('SELECT COUNT(*) FROM a_token_miners WHERE lower(wallet)=?', (wl,)).fetchone()[0]
    tr = c.execute('SELECT COUNT(*) FROM a_token_trades WHERE lower(wallet)=?', (wl,)).fetchone()[0]
    tf = c.execute('SELECT COUNT(*) FROM a_token_transfers WHERE lower(from_wallet)=? OR lower(to_wallet)=?', (wl, wl)).fetchone()[0]
    print('  %s  A=%-22s miners=%d trades=%d transfers=%d  reg=%s' % (wl, a, mn, tr, tf, ts(u['created_at']) if u else 'NOT-REG'))
print()

print('=== 入账失败日志检查 ===')
for f in ['/opt/wg-platform/logs/server.stdout.log', '/opt/wg-platform/logs/server.stderr.log']:
    if not os.path.exists(f):
        print('  (missing) %s' % f); continue
    hits = []
    with open(f, encoding='utf-8', errors='ignore') as fh:
        for line in fh:
            if '币奖入账失败' in line or ('抽奖' in line and 'fail' in line.lower()):
                hits.append(line.rstrip())
    print('  %s : hits=%d' % (f, len(hits)))
    for h in hits[-8:]:
        print('    ' + h[:200])
'@

$bytes = [System.Text.Encoding]::UTF8.GetBytes(($py -replace "`r", ""))
$b64 = [System.Convert]::ToBase64String($bytes)

$ssh = New-SSHSession -ComputerName $IP -Credential $cred -ErrorOnUntrusted -ConnectionTimeout 120
$sid = $ssh.SessionId
Invoke-SSHCommand -SessionId $sid -Command "rm -f /tmp/_qlot.py.b64 /tmp/_qlot.py" -TimeOut 20 | Out-Null
for ($i = 0; $i -lt $b64.Length; $i += 40000) {
  $len = [Math]::Min(40000, $b64.Length - $i)
  Invoke-SSHCommand -SessionId $sid -Command "printf '%s' '$($b64.Substring($i,$len))' >> /tmp/_qlot.py.b64" -TimeOut 30 | Out-Null
}
$r = Invoke-SSHCommand -SessionId $sid -Command "base64 -d /tmp/_qlot.py.b64 > /tmp/_qlot.py && rm -f /tmp/_qlot.py.b64; (python3 /tmp/_qlot.py 2>&1 || python /tmp/_qlot.py 2>&1) | head -140" -TimeOut 240
Write-Output ($r.Output -join "`n")
Remove-SSHSession -SessionId $sid | Out-Null
