import concurrent.futures
import datetime
import hashlib
import json
import pathlib
import re
import urllib.request

audit = pathlib.Path(__file__).resolve().parent
manifest = json.loads((audit / 'release-manifest.json').read_text(encoding='utf-8'))
paths = {
    '/':'public/index.html',
    '/js/page-loader.js?v=20261011-aix-chart-1':'public/js/page-loader.js',
    '/js/a-token-trade.js?v=20261011-aix-chart-1':'public/js/a-token-trade.js',
    '/api/wallet/session':None,
}
def check(item):
    uri, name = item
    result = {'uri':uri, 'passed':False}
    try:
        request = urllib.request.Request('https://axix.cc' + uri, headers={'User-Agent':'Mozilla/5.0 Chrome/132.0.0.0 Safari/537.36', 'Cache-Control':'no-cache'})
        with urllib.request.urlopen(request, timeout=25) as response:
            body = response.read()
            result.update({'status':response.status, 'cf_cache_status':response.headers.get('CF-Cache-Status')})
            assert response.status == 200
            if name:
                normalized = re.sub(rb'<script\b[^>]*\bsrc=["\']https://static\.cloudflareinsights\.com/beacon\.min\.js[^>]*>.*?</script>\s*', b'', body, flags=re.S) if name.endswith('.html') else body
                result['sha256'] = hashlib.sha256(normalized).hexdigest()
                assert result['sha256'] == manifest[name]['after'], 'Public source hash mismatch'
            else:
                assert json.loads(body).get('authenticated') is False
        result['passed'] = True
    except Exception as error:
        result['error'] = str(error)
    return result
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    checks = list(pool.map(check, paths.items()))
out = {'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'passed':all(item['passed'] for item in checks), 'checks':checks}
(audit / 'public-verification.json').write_text(json.dumps(out, indent=2), encoding='utf-8')
print(json.dumps(out, indent=2))
if not out['passed']:
    raise SystemExit(1)
