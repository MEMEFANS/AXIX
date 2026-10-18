import concurrent.futures
import datetime
import hashlib
import json
import pathlib
import re
import urllib.error
import urllib.request

audit = pathlib.Path(__file__).resolve().parent
manifest = json.loads((audit / 'release-manifest.json').read_text(encoding='utf-8'))
protected = json.loads((audit / 'release-payload.json').read_text(encoding='utf-8'))['protected']
paths = {
    '/':'public/index.html', '/admin.html':'public/admin.html', '/funds-admin.html':'public/funds-admin.html',
    '/js/operator-admin.js?v=20261011-permissions-1':'public/js/operator-admin.js',
    '/js/admin-lottery.js?v=20261011-security-2':'public/js/admin-lottery.js',
    '/js/admin-dialogs.js?v=20261011-security-1':'public/js/admin-dialogs.js',
    '/js/funds-admin.js?v=20261011-permissions-1':'public/js/funds-admin.js',
    '/styles/funds-admin.css?v=20261011-security-1':'public/styles/funds-admin.css',
    '/js/support-chat.js?v=20261011-security-2':'public/js/support-chat.js',
    '/js/page-loader.js?v=20261011-pages-security-2':'public/js/page-loader.js',
    '/sw.js?v=9':'public/sw.js', '/%61dmin.html':'public/admin.html',
    '/%66unds-admin.html':'public/funds-admin.html', '/withdraw-admin.html':None,
    '/api/wallet/session':None, '/api/wallet/admin/session':None,
}
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
def check(item):
    uri,name = item
    result = {'uri':uri,'passed':False}
    try:
        opener = urllib.request.build_opener(NoRedirect())
        req = urllib.request.Request('https://axix.cc'+uri,headers={'User-Agent':'Mozilla/5.0 Chrome/132.0.0.0 Safari/537.36','Cache-Control':'no-cache'})
        try: response = opener.open(req,timeout=25)
        except urllib.error.HTTPError as error: response = error
        with response:
            body = response.read()
            result.update({'status':response.code,'cache_control':response.headers.get('Cache-Control'),'cf_cache_status':response.headers.get('CF-Cache-Status')})
            if name:
                assert response.code == 200
                normalized = re.sub(rb'<script\b[^>]*\bsrc=["\']https://static\.cloudflareinsights\.com/beacon\.min\.js[^>]*>.*?</script>\s*',b'',body,flags=re.S) if name.endswith('.html') else body
                result['cloudflare_beacon_inserted'] = normalized != body
                assert hashlib.sha256(normalized).hexdigest() == (manifest[name]['after'] if name in manifest else protected[name]), 'Public source hash mismatch'
                if name in ['public/admin.html','public/funds-admin.html']:
                    csp = response.headers.get('Content-Security-Policy','')
                    assert "'unsafe-inline'" not in csp.split('script-src',1)[1].split(';',1)[0]
                    assert result['cache_control'] == 'no-store'
                    result['strict_script_csp'] = True
                if uri == '/':
                    assert b'20261011-pages-security-2' in body and b'/sw.js?v=9' in body
            elif uri == '/withdraw-admin.html':
                assert response.code == 302 and response.headers.get('Location') == '/funds-admin.html'
            elif uri == '/api/wallet/admin/session':
                assert response.code == 401 and json.loads(body).get('code') == 'FUNDS_AUTH_REQUIRED'
            else:
                assert response.code == 200 and json.loads(body).get('authenticated') is False
        result['passed'] = True
    except Exception as error:
        result['error'] = str(error)
    return result
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
    checks = list(pool.map(check,paths.items()))
out = {'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'passed':all(item['passed'] for item in checks),'checks':checks}
(audit / 'public-verification.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'passed':out['passed'],'paths_checked':len(checks),'failures':[item for item in checks if not item['passed']]},ensure_ascii=False,indent=2))
if not out['passed']: raise SystemExit(1)
