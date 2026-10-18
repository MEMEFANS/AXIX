import base64
import gzip
import json
import pathlib
import re

root = pathlib.Path(__file__).resolve().parent
payload = json.loads((root / 'deploy-payload.json').read_text(encoding='utf-8'))
candidate = root / 'production-candidate'
version = '20261011-pages-1'
features = ['trade-account', 'platform-client', 'wallet-funds', 'assets', 'ai-managed', 'strategy', 'staking', 'hyperliquid-client', 'portfolio', 'vaults', 'mobile-trade', 'trade-chart', 'trade-alerts', 'trade-history', 'trade-funding', 'trade-favorites', 'trade-trades', 'trade-depth', 'trade-book-tabs', 'a-token-trade', 'lottery', 'referrals', 'leaderboard', 'community-links', 'support-chat', 'ledger', 'ai', 'a-token-transfer', 'a-token-withdrawal']
paths = {'/': 'public/index.html'}
for name in features:
    paths['/js/' + name + '.js?v=' + version] = 'public/js/' + name + '.js'
for name in payload['files']:
    if name.endswith('.js'):
        paths['/' + name.removeprefix('public/') + '?v=' + version] = name
html = (candidate / 'public/index.html').read_text(encoding='utf-8')
for uri in re.findall(r'<script\b[^>]*\bsrc="([^"]+)"', html):
    if uri.startswith('/'):
        paths[uri] = 'public' + uri.split('?', 1)[0]
paths['/vendor/lightweight-charts.js?v=1'] = 'public/vendor/lightweight-charts.js'
paths['/vendor/wallet/connector.js?v=16'] = 'public/vendor/wallet/connector.js'
for uri, name in paths.items():
    assert (candidate / name).is_file(), name
    assert name in payload['files'] or name in payload['protected'], name
payload['verify_paths'] = paths
(root / 'verify-paths.json').write_text(json.dumps(paths, indent=2), encoding='utf-8')
(root / 'deploy-payload.json').write_text(json.dumps(payload, indent=2), encoding='utf-8')
packed = base64.b64encode(gzip.compress(json.dumps(payload).encode('utf-8'))).decode('ascii')
source = (root / 'deploy-template.py').read_text(encoding='utf-8')
assert source.count('__PAYLOAD__') == 1
source = source.replace('__PAYLOAD__', packed)
compile(source, 'deploy-generated.py', 'exec')
(root / 'deploy-generated.py').write_text(source, encoding='utf-8')
print('Validated static deployment generated: ' + str(len(source)) + ' characters; ' + str(len(paths)) + ' origin/public paths')
