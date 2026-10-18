import concurrent.futures
import datetime
import hashlib
import json
import pathlib
import re
import urllib.error
import urllib.request

root = pathlib.Path(__file__).resolve().parent
manifest = json.loads((root / 'deploy-manifest.json').read_text(encoding='utf-8'))
protected = json.loads((root / 'deploy-payload.json').read_text(encoding='utf-8'))['protected']
paths = {'/': 'public/index.html', '/js/earn.js?v=20261011-team-fast-2': 'public/js/earn.js',
         '/js/assets.js?v=20261011-aix-quantity': 'public/js/assets.js',
         '/js/page-loader.js?v=5-assets': 'public/js/page-loader.js',
         '/api/a-token/team/summary': None, '/api/wallet/session': None}


def check(item):
    uri, name = item
    req = urllib.request.Request('https://axix.cc' + uri,
                                 headers={'User-Agent': 'Mozilla/5.0 Chrome/132.0.0.0 Safari/537.36', 'Cache-Control': 'no-cache'})
    try:
        response = urllib.request.urlopen(req, timeout=20)
    except urllib.error.HTTPError as error:
        if uri != '/api/a-token/team/summary' or error.code != 401:
            raise
        response = error
    with response:
        body = response.read()
        out = {'uri':uri, 'status':response.code, 'cf_cache_status':response.headers.get('CF-Cache-Status'),
               'cache_control':response.headers.get('Cache-Control')}
        if name:
            normalized = body
            if uri == '/':
                normalized = re.sub(rb'<script\b[^>]*\bsrc=["\']https://static\.cloudflareinsights\.com/beacon\.min\.js[^>]*>.*?</script>\s*', b'', body, flags=re.S)
                out['cloudflare_analytics_inserted'] = normalized != body
                out['new_earn_script_version'] = b'/js/earn.js?v=20261011-team-fast-2' in body
                assert out['new_earn_script_version'], 'Public page is outdated'
            digest = hashlib.sha256(normalized).hexdigest()
            expected = manifest[name]['after'] if name in manifest else protected[name]
            assert digest == expected, 'Public release content mismatch: ' + uri
            out['origin_content_sha256'] = digest
        elif uri == '/api/a-token/team/summary':
            assert response.code == 401 and json.loads(body).get('code') == 'SESSION_REQUIRED'
            out['requires_wallet_login'] = True
        else:
            assert response.code == 200 and json.loads(body).get('authenticated') is False
        return out


with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    checks = list(pool.map(check, paths.items()))
out = {'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'checks':checks}
(root / 'public-verification.json').write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(out, ensure_ascii=False, indent=2))
