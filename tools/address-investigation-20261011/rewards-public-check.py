import pathlib,json,urllib.request,hashlib,concurrent.futures,datetime,re
root=pathlib.Path(__file__).parent
manifest=json.loads((root/'rewards-fix/deploy-manifest.json').read_text(encoding='utf-8'))
paths={'/':None,'/api/wallet/session':None,'/admin.html':'public/admin.html','/js/operator-admin.js?v=45-assets-20261011':'public/js/operator-admin.js'}
def check(item):
    uri,name=item
    req=urllib.request.Request('https://axix.cc'+uri,headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36','Cache-Control':'no-cache'})
    with urllib.request.urlopen(req,timeout=20) as r:
        body=r.read();out={'uri':uri,'status':r.status,'sha256':hashlib.sha256(body).hexdigest(),'cf_cache_status':r.headers.get('CF-Cache-Status'),'cache_control':r.headers.get('Cache-Control')}
        if name:
            normalized=body
            if uri=='/admin.html':
                # Cloudflare inserts its own analytics script into public HTML.
                # Remove only that known insertion; compare all remaining bytes.
                normalized=re.sub(rb'<script\b[^>]*\bsrc=["\']https://static\.cloudflareinsights\.com/beacon\.min\.js[^>]*>.*?</script>\s*',b'',body,flags=re.S)
                out['cloudflare_analytics_inserted']=normalized!=body
                out['new_admin_script_version']=b'operator-admin.js?v=45-assets-20261011' in body
            out['origin_content_sha256']=hashlib.sha256(normalized).hexdigest()
            assert out['origin_content_sha256']==manifest[name]['after'],'Public release content mismatch: '+uri
        if uri=='/api/wallet/session':assert json.loads(body).get('authenticated') is False
        return out
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(check,paths.items()))
out={'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'public_checks':results}
(root/'rewards-public-result.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(out,ensure_ascii=False,indent=2))
