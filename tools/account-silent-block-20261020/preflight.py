import json
import sqlite3
from pathlib import Path

codes = ['7M2VGLHB', 'GP7R29JL', 'ZSZ9ZS34']
with sqlite3.connect('file:/var/lib/wg-platform/wg-platform.sqlite?mode=ro', uri=True, timeout=10) as db:
    db.row_factory = sqlite3.Row
    tables = {row['name'] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    out = {'readonly': True, 'codes': {}, 'tables': sorted(tables)}
    for code in codes:
        ids = [dict(row) for row in db.execute('SELECT wallet,user_id FROM a_token_user_ids WHERE user_id=? COLLATE NOCASE', (code,))]
        refs = [dict(row) for row in db.execute('SELECT wallet,code FROM platform_referral_links WHERE code=? COLLATE NOCASE', (code,))]
        wallets = sorted({row['wallet'].lower() for row in ids + refs})
        item = {'ids': ids, 'referrals': refs, 'wallets': wallets}
        if len(wallets) == 1:
            wallet = wallets[0]
            item['userExists'] = db.execute('SELECT COUNT(*) FROM wallet_users WHERE address=? COLLATE NOCASE', (wallet,)).fetchone()[0]
            item['sessions'] = db.execute('SELECT COUNT(*) FROM wallet_sessions WHERE address=? COLLATE NOCASE', (wallet,)).fetchone()[0]
            item['agents'] = [dict(row) for row in db.execute('SELECT id,username,status FROM agent_accounts WHERE wallet_address=? COLLATE NOCASE', (wallet,))]
            for name in ['a_token_claims', 'a_token_withdrawals', 'withdrawals']:
                if name not in tables:
                    continue
                columns = {row['name'] for row in db.execute('PRAGMA table_info(' + name + ')')}
                wallet_column = 'wallet' if 'wallet' in columns else 'address' if 'address' in columns else None
                if wallet_column and 'status' in columns:
                    item[name] = [dict(row) for row in db.execute('SELECT status,COUNT(*) AS count FROM ' + name + ' WHERE ' + wallet_column + '=? COLLATE NOCASE GROUP BY status', (wallet,))]
        out['codes'][code] = item
    block_row = db.execute('SELECT payload_json FROM service_settings WHERE setting_key=?', ('wallet_account_blocks',)).fetchone()
    blocks = json.loads(block_row[0]) if block_row else {'wallets': {}}
    out['existingBlockCount'] = len(blocks.get('wallets', {}))
    out['targetExistingBlocks'] = {wallet: blocks.get('wallets', {}).get(wallet) for item in out['codes'].values() for wallet in item['wallets']}
    out['settingsKeys'] = [row[0] for row in db.execute('SELECT setting_key FROM service_settings') if any(word in row[0] for word in ['wallet', 'session', 'pending'])]
print(json.dumps(out, ensure_ascii=False))
