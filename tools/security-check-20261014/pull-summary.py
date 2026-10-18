import hashlib,json,pathlib
expected='c26b2ecbc2dcad426a77a52cff174fa4c15a5e8e41626bec74a4e3c6cd0db74f'
rows=[]
for p in pathlib.Path('/tmp').glob('wg-admin-speed-*/data-scan.py'):
    if hashlib.sha256(p.read_bytes()).hexdigest()!=expected:continue
    result=p.parent/'data-scan.json'
    if result.is_file() and result.stat().st_size:
        d=json.loads(result.read_text())
        rows.append({'captured':d['captured_beijing'],'readonly':d['readonly'],'source_bytes':result.stat().st_size,'social_total':d['social_total'],'invalid_count':len(d['social_invalid']),'social_script_like':d['social_script_like'],'support_total':d['support_total'],'support_script_like':d['support_script_like'],'target_support':d['target_support'],'settings_script_like':d['settings_script_like'],'target_users':d['target'].get('wallet_users_address'),'target_platform':d['target'].get('platform_accounts_address'),'target_fills':d['target'].get('fills_address'),'security_source_checks':d['security_source_checks'],'recent_backups':d['recent_backups']})
print(json.dumps(rows,ensure_ascii=False,separators=(',',':')))