import urllib.request,urllib.error,http.cookiejar,json,os
root='http://127.0.0.1:8082'
env={}
for line in open('/opt/wg-platform/.env'):
    line=line.strip()
    if not line or line.startswith('#') or '=' not in line:continue
    k,v=line.split('=',1);env[k.strip()]=v.strip().strip('"').strip("'")
jar=http.cookiejar.CookieJar();opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(path,body,method='POST'):
    req=urllib.request.Request(root+path,data=json.dumps(body).encode(),method=method,headers={'Content-Type':'application/json','Origin':root})
    try:
        with opener.open(req,timeout=12) as r:return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError('API request failed: '+path+' status='+str(e.code)) from None
try:
    login=call('/api/admin/login',{'username':env['PLATFORM_ADMIN_USERNAME'],'password':env['PLATFORM_ADMIN_PASSWORD']})
    results=[]
    for wallet in ['0xd36ddfb9d3fa6b326b49e6eab68c5b961bc3ba59','0xf75a7c032b7a484269ced5663f7fa10acf63b1ac']:
        r=call('/api/admin/users/'+wallet+'/withdraw-freeze',{'frozen':True,'reason':'Confirmed stored XSS balance fraud; incident 20261011'})
        results.append({'wallet':wallet,'frozen':r.get('frozen',r.get('result',{}).get('frozen')),'ok':r.get('ok')})
    automation=call('/api/admin/withdrawal-automation',{'enabled':False,'reviewThresholdUsdt':'0.1','dailyLimitUsdt':'0.1','usdtMultipleOfTen':False},'PATCH')
    call('/api/admin/logout',{})
    print(json.dumps({'containment':results,'automation_enabled':automation.get('enabled')},indent=2))
except Exception as e:
    print(json.dumps({'error':str(e)}));raise SystemExit(1)
