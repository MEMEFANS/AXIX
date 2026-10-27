import sqlite3, datetime

db = sqlite3.connect('file:/var/lib/wg-platform/wg-platform.sqlite?mode=ro', uri=True)
db.row_factory = sqlite3.Row

addrs = {
    '0x9aa09a7ffacdcc3178d19a17b7ab9e48beb11419': 'ZSZ9ZS34',
    '0xd2e34ad4a21647065590994eb04b310954d3a0b0': '来源1(25AIX)',
    '0x04741c4a459f4c24487a12dd336207245ea94694': '来源2(25AIX)',
    '0x8f0fc6f5657adbb1ca9b33d17e3344e28446a817': '来源3(25AIX)',
    '0x2f17903e734cba85811acdffcc1a0e4f5561cb85': '来源4(25AIX)',
}
wl = list(addrs)

def bj(ms):
    return (datetime.datetime.fromtimestamp(ms/1000, datetime.timezone.utc) + datetime.timedelta(hours=8)).strftime('%m-%d %H:%M:%S')

print('=== 平台注册情况 ===')
q = ','.join('?'*len(wl))
for r in db.execute(f'SELECT wallet, user_id, created_at FROM a_token_user_ids WHERE LOWER(wallet) IN ({q})', wl):
    code = addrs.get(r['wallet'].lower(), r['wallet'])
    print(f"{r['wallet']} -> 邀请码 {r['user_id']} | 注册: {bj(r['created_at'])}")
missing = [w for w in wl if not db.execute('SELECT 1 FROM a_token_user_ids WHERE LOWER(wallet)=?', (w,)).fetchone()]
for w in missing:
    print(f"{addrs[w]} ({w}): 未注册平台用户")

print()
print('=== withdrawals 表：进行中的提现（pending 类状态） ===')
rows = db.execute(f"SELECT * FROM withdrawals WHERE LOWER(wallet) IN ({q}) AND status NOT IN ('rejected','completed','failed','cancelled') ORDER BY created_at", wl).fetchall()
print('进行中笔数:', len(rows))
for r in rows:
    d = dict(r)
    code = addrs.get(str(d['wallet']).lower(), d['wallet'])
    print(f"[{bj(d['created_at'])}] {code} | {d['asset']} {round(int(d['amount_units'])/1e6,2)} | 状态:{d['status']} | 自动审批:{d['automatic_approved']} | id:{d['id']}")

print()
print('=== withdrawals 表：这些地址全部历史提现（对照） ===')
rows = db.execute(f'SELECT * FROM withdrawals WHERE LOWER(wallet) IN ({q}) ORDER BY created_at DESC', wl).fetchall()
print('历史总笔数:', len(rows))
for r in rows:
    d = dict(r)
    code = addrs.get(str(d['wallet']).lower(), d['wallet'])
    print(f"[{bj(d['created_at'])}] {code} | {d['asset']} {round(int(d['amount_units'])/1e6,2)} | 状态:{d['status']}")

print()
print('=== a_token_withdrawals 表（AIX 链上提现）：进行中 ===')
rows = db.execute(f"SELECT * FROM a_token_withdrawals WHERE LOWER(wallet) IN ({q}) AND status NOT IN ('rejected','failed','confirmed') ORDER BY created_at", wl).fetchall()
print('进行中笔数:', len(rows))
for r in rows:
    d = dict(r)
    code = addrs.get(str(d['wallet']).lower(), d['wallet'])
    print(f"[{bj(d['created_at'])}] {code} | AIX {round(int(d['amount_units'])/1e18,4)} | 状态:{d['status']}")
