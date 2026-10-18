import concurrent.futures, datetime, hashlib, json, time, urllib.error, urllib.request
BASE='https://axix.cc'
PATHS=['/','/admin.html','/funds-admin.html','/api/admin/session','/api/admin/dashboard?view=overview','/api/wallet/admin/session','/api/admin/test-credits','/api/admin/a-token/grant','/.env','/.git/config','/src/server.js','/wg-platform.sqlite']
def check(path):
    started=time.monotonic()
    request=urllib.request.Request(BASE+path,headers={'User-Agent':'WG-Owner-Security-Readonly-20261014','Cache-Control':'no-cache'})
    try:
        response=urllib.request.urlopen(request,timeout=20)
    except urllib.error.HTTPError as error:
        response=error
    except Exception as error:
        return {'path':path,'error':type(error).__name__,'duration_ms':round((time.monotonic()-started)*1000)}
    with response:
        body=response.read(2000000)
        return {'path':path,'status':response.status,'duration_ms':round((time.monotonic()-started)*1000),'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest(),'headers':{key:response.headers.get(key) for key in ['Content-Type','Cache-Control','Content-Security-Policy','CF-Cache-Status','X-Content-Type-Options','Last-Modified']},'error_code':json.loads(body).get('code') if response.headers.get('Content-Type','').startswith('application/json') and body.startswith(b'{') else None}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    checks=list(pool.map(check,PATHS))
result={'captured_beijing':datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(),'readonly':True,'checks':checks}
print(json.dumps(result,ensure_ascii=False))
