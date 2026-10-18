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
payload = json.loads((root / 'deploy-payload.json').read_text(encoding='utf-8'))
paths = dict(payload['verify_paths'])
paths['/api/wallet/session'] = None
paths['/api/a-token/team/summary'] = None


def check(item):
    uri, name = item
    result = {'uri': uri, 'passed': False}
    try:
        request = urllib.request.Request('https://axix.cc' + uri, headers={'User-Agent': 'Mozilla/5.0 Chrome/132.0.0.0 Safari/537.36', 'Cache-Control': 'no-cache'})
        try:
            response = urllib.request.urlopen(request, timeout=20)
        except urllib.error.HTTPError as error:
            if uri != '/api/a-token/team/summary' or error.code != 401:
                raise
            response = error
        with response:
            body = response.read()
            result.update({'status': response.code, 'cf_cache_status': response.headers.get('CF-Cache-Status'), 'cache_control': response.headers.get('Cache-Control')})
            if name:
                assert response.code == 200
                normalized = body
                if uri == '/':
                    normalized = re.sub(rb'<script\b[^>]*\bsrc=["\']https://static\.cloudflareinsights\.com/beacon\.min\.js[^>]*>.*?</script>\s*', b'', body, flags=re.S)
                    result['cloudflare_analytics_inserted'] = normalized != body
                    result['new_page_loader_version'] = b'/js/page-loader.js?v=20261011-pages-1' in body
                    assert result['new_page_loader_version'], 'Public HTML is outdated'
                digest = hashlib.sha256(normalized).hexdigest()
                expected = manifest[name]['after'] if name in manifest else payload['protected'][name]
                assert digest == expected, 'Public release content mismatch: ' + uri
                result['origin_content_sha256'] = digest
            elif uri == '/api/a-token/team/summary':
                assert response.code == 401 and json.loads(body).get('code') == 'SESSION_REQUIRED'
                result['requires_wallet_login'] = True
            else:
                assert response.code == 200 and json.loads(body).get('authenticated') is False
            result['passed'] = True
    except Exception as error:
        result['error'] = str(error)
    return result


with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    checks = list(pool.map(check, paths.items()))
out = {'captured_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'passed': all(item['passed'] for item in checks), 'checks': checks}
(root / 'public-verification.json').write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'passed': out['passed'], 'paths_checked': len(checks), 'failures': [item for item in checks if not item['passed']], 'homepage': checks[0]}, ensure_ascii=False, indent=2))
if not out['passed']:
    raise SystemExit(1)
