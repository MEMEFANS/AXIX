"""Read-only production code and deployment metadata; never reads credentials."""
import base64
import hashlib
import io
import json
import pathlib
import sqlite3
import subprocess
import tarfile

ROOT = pathlib.Path('/opt/wg-platform')
FILES = [
 'src/a-token-activation-service.js','src/a-token-api.js','src/a-token-miner-service.js',
 'src/a-token-service.js','src/a-token-team-service.js','src/database.js','src/a-token-admin-api.js',
 'src/server.js','src/wallet-service.js','public/js/earn.js','public/js/a-token-trade.js',
 'public/js/operator-admin.js','public/js/page-loader.js','public/index.html','public/admin.html',
 'public/promo-miner.html','public/promo-guide.html','public/promo-article.html',
 'public/js/account-action-guard.js','package.json',
]
hashes = {}
archive_bytes = io.BytesIO()
with tarfile.open(fileobj=archive_bytes,mode='w:gz') as archive:
 for name in FILES:
  path=ROOT/name
  assert path.is_file(), 'Missing baseline: '+name
  hashes[name]=hashlib.sha256(path.read_bytes()).hexdigest()
  archive.add(path,arcname=name,recursive=False)
with sqlite3.connect('file:/var/lib/wg-platform/wg-platform.sqlite?mode=ro',uri=True,timeout=15) as db:
 db.execute('PRAGMA query_only=ON')
 settings={key: db.execute('SELECT payload_json FROM service_settings WHERE setting_key=?',(key,)).fetchone()
           for key in ['wallet_account_blocks','a_token_activation_aix_cutover_v1']}
 blocks=json.loads(settings['wallet_account_blocks'][0])['wallets']
 info={
  'blockCount':len(blocks),'silentBlockCount':sum(v.get('silent') is True for v in blocks.values()),
  'aixCutoverPresent': settings['a_token_activation_aix_cutover_v1'] is not None,
  'activationCount':db.execute('SELECT COUNT(*) FROM a_token_activations').fetchone()[0],
  'minerCount':db.execute('SELECT COUNT(*) FROM a_token_miners').fetchone()[0],
  'activationIndexes':[list(r) for r in db.execute("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='a_token_activations'")],
 }
info.update({
 'service':subprocess.check_output(['systemctl','is-active','wg-platform'],text=True).strip(),
 'restarts':subprocess.check_output(['systemctl','show','wg-platform','--property=NRestarts','--value'],text=True).strip(),
 'node':subprocess.check_output(['node','--version'],text=True).strip(),
 'diskFreeBytes':__import__('shutil').disk_usage('/var/lib/wg-platform').free,
})
print(json.dumps({'readonly':True,'hashes':hashes,'info':info,
 'archive':base64.b64encode(archive_bytes.getvalue()).decode()}))
