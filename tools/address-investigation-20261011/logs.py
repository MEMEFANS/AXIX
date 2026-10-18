import re,json,datetime,os,collections,subprocess,hashlib
W='0xd36ddfb9d3fa6b326b49e6eab68c5b961bc3ba59'
out={'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_checks':{},'configuration':[]}
source_requests={
 'public/js/admin-lottery.js': [r'document.write',r'window.open',r'data-shot'],
 'src/lottery-service.js':[r'function submitSocial',r'screenshotUrl:'],
 'src/database.js':[r'function loadWalletState',r'SELECT address,payload_json'],
 'src/server.js':[r'Content-Security-Policy',r"'/api/admin/test-credits'",r'function adminSession',r"'/api/admin/a-token/grant'"],
 'src/a-token-admin-api.js':[r'/grant',r'grantTokens'],
}
for file,patterns in source_requests.items():
    p='/opt/wg-platform/'+file
    if not os.path.exists(p): continue
    s=open(p).read(); lines=s.splitlines();selected=[]
    for i,line in enumerate(lines):
        if any(re.search(pt,line) for pt in patterns):
            selected.extend({'line':j+1,'text':lines[j]} for j in range(max(0,i-2),min(len(lines),i+4)))
    out['source_checks'][file]={'sha256':hashlib.sha256(s.encode()).hexdigest(),'excerpts':list({r['line']:r for r in selected}.values())[:100]}
for path in ['/etc/nginx/nginx.conf']+__import__('glob').glob('/etc/nginx/sites-enabled/*')+__import__('glob').glob('/etc/nginx/conf.d/*'):
    if not os.path.isfile(path): continue
    lines=[]
    for i,line in enumerate(open(path)):
        if re.search(r'log_format|access_log|real_ip|proxy_set_header.*(Forwarded|Real-IP)|listen|server_name',line):
            lines.append({'line':i+1,'text':line.strip()})
    out['configuration'].append({'file':path,'lines':lines})
pattern=re.compile(r'^(\S+) .*?\[([^\]]+)\] "(\S+) (.*?) HTTP/[^" ]+" (\d+) \S+ "([^"\r\n]*)" "([^"\r\n]*)"')
paths=['/api/lottery/social','/api/admin/a-token/grant','/api/admin/test-credits','/api/admin/withdrawal-automation','/api/admin/a-token/withdraw/mode','/api/admin/agents','/api/admin/lottery/points','/api/wallet/withdraw','/api/a-token/withdraw','/api/a-token/claim','/api/admin/community-links']
groups={}; records=[]; nonmatch=0;hits=0
with open('/var/log/nginx/access.log',errors='replace') as f:
    for line in f:
        if '10/Oct/2026:' not in line and '11/Oct/2026:' not in line: continue
        if not any(x in line for x in paths) and W not in line.lower(): continue
        m=pattern.match(line)
        if not m: nonmatch+=1;continue
        ip,t,method,uri,status,ref,ua=m.groups(); path=uri.split('?',1)[0]
        dt=datetime.datetime.strptime(t,'%d/%b/%Y:%H:%M:%S %z')
        if dt.timestamp()<1791582000 or dt.timestamp()>1791660600: continue
        key=(ip,method,path,status); g=groups.setdefault(key,{'ip':ip,'method':method,'path':path,'status':int(status),'count':0,'first':t,'last':t,'user_agents':set(),'referer_paths':set()});g['count']+=1;g['last']=t;g['user_agents'].add(ua[:220]);g['referer_paths'].add(ref.split('?',1)[0]);hits+=1
        if path in paths and len(records)<350: records.append({'ip':ip,'time':t,'method':method,'path':path,'status':int(status),'referer':ref.split('?',1)[0],'user_agent':ua[:220]})
for g in groups.values():
    g['user_agents']=sorted(g['user_agents'])[:3];g['referer_paths']=sorted(g['referer_paths'])[:5]
out['access_groups']=sorted(groups.values(),key=lambda g:(g['first'],g['ip']))
out['selected_records']=records
out['matched_requests']=hits;out['unparsed_lines']=nonmatch
out['app_address_events']=[]
for p in ['/opt/wg-platform/logs/server.stdout.log','/opt/wg-platform/logs/server.stderr.log']:
    if not os.path.exists(p): continue
    for line in open(p,errors='replace'):
        if W in line.lower() and not re.search(r'cookie|signature|token|password',line,re.I):
            out['app_address_events'].append({'file':p,'text':line.strip()[:350]})
out['app_address_events']=out['app_address_events'][-30:]
out['service_status']=subprocess.run(['systemctl','show','wg-platform','--property=MainPID,ActiveEnterTimestamp,ExecMainStartTimestamp'],capture_output=True,text=True,timeout=5).stdout
print(json.dumps(out,ensure_ascii=False,indent=2))
