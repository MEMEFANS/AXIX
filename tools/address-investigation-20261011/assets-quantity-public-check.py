import concurrent.futures
import datetime
import hashlib
import json
import pathlib
import re
import urllib.request

root = pathlib.Path(__file__).parent
manifest = json.loads((root / 'assets-quantity-fix/deploy-manifest.json').read_text(encoding='utf-8'))
paths = {'/': 'public/index.html', '/js/assets.js?v=20261011-aix-quantity': 'public/js/assets.js',
         '/js/trade-account.js?v=32-assets': 'public/js/trade-account.js',
         '/js/page-loader.js?v=5-assets': 'public/js/page-loader.js'}


def check(item):
    uri, name = item
    req = urllib.request.Request('https://axix.cc' + uri,
                                 headers={'User-Agent': 'Mozilla/5.0 Chrome/132.0.0.0 Safari/537.36',
                                          'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(req, timeout=20) as response:
        body = response.read()
        out = {'uri': uri, 'status': response.status,
               'sha256': hashlib.sha256(body).hexdigest(),
               'cf_cache_status': response.headers.get('CF-Cache-Status'),
               'cache_control': response.headers.get('Cache-Control')}
        normalized = body
        if uri == '/':
            normalized = re.sub(rb'<script\b[^>]*\bsrc=["\']https://static\.cloudflareinsights\.com/beacon\.min\.js[^>]*>.*?</script>\s*',
                                b'', body, flags=re.S)
            out['cloudflare_analytics_inserted'] = normalized != body
            out['new_page_loader_version'] = b'/js/page-loader.js?v=5-assets' in body
            assert out['new_page_loader_version'], 'Public HTML page loader version is outdated'
        out['origin_content_sha256'] = hashlib.sha256(normalized).hexdigest()
        assert out['origin_content_sha256'] == manifest[name]['after'], 'Public release content mismatch: ' + uri
        return out


with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    results = list(pool.map(check, paths.items()))
out = {'captured_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
       'public_checks': results}
(root / 'assets-quantity-public-result.json').write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(out, ensure_ascii=False, indent=2))
