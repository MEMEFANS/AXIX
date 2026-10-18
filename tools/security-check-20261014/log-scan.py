import collections, datetime, gzip, json, os, pathlib, re, subprocess, urllib.parse
ZONE=datetime.timezone(datetime.timedelta(hours=8))
NOW=datetime.datetime.now(ZONE)
SINCE=NOW.timestamp()-24*3600
TODAY=NOW.replace(hour=0,minute=0,second=0,microsecond=0).timestamp()
PATCH=datetime.datetime.fromisoformat('2026-10-11T10:22:00+08:00').timestamp()
regex=re.compile(r'^(\S+) .*?\[([^\]]+)\] "(\S+) (.*?) HTTP/[^" ]+" (\d+) (\S+) "([^"\r\n]*)" "([^"\r\n]*)"')
scan_re=re.compile(r'(?:^|/)(?:\.env(?:[./]|$)|\.git(?:/|$)|wp-admin|wp-login|xmlrpc|phpmyadmin|phpunit|vendor/phpunit|cgi-bin|actuator|\.aws|\.ssh)|\.(?:php\d?|asp|aspx|jsp|sql|bak)(?:[?/]|$)|/etc/passwd|/proc/self|\.\./|<script|(?:union\s+select|sleep\(|benchmark\(|jndi:)',re.I)
legacy_re=re.compile(r'^/api/admin/(?:test-credits|withdrawals|withdrawal-automation|a-token/(?:grant|debit|grant-miner|grant-stake|activations/confirm))(?:/|$)')
def clean_path(uri):
    path=uri.split('?',1)[0]
    return re.sub(r'[\r\n\x00-\x1f]','',path)[:240]
def entry(ip,t,method,uri,status,ua):
    return {'ip':ip,'time':t,'method':method,'path':clean_path(uri),'status':int(status),'ua':ua[:180]}
def group_add(groups,e):
    key=(e['ip'],e['method'],e['path'],e['status'])
    if key not in groups: groups[key]={**e,'count':0,'first':e['time'],'last':e['time']}
    groups[key]['count']+=1
    groups[key]['last']=e['time']
out={'captured_beijing':NOW.isoformat(),'window_start_beijing':datetime.datetime.fromtimestamp(SINCE,ZONE).isoformat(),'readonly':True}
status=collections.Counter(); paths=collections.Counter(); ips=collections.Counter(); hours=collections.Counter(); minutes=collections.Counter();ipminutes=collections.Counter()
scans={};highrisk={};legacy={};ratelimited={};adminlogins={}; errors={}; today_status=collections.Counter();sensitive_samples=collections.deque(maxlen=700)
total=0;today_total=0;unparsed=0;date_cache={};source_files=[];own=0
valid_days={(NOW-datetime.timedelta(days=d)).strftime('%d/%b/%Y') for d in range(5)}
for filename in sorted(pathlib.Path('/var/log/nginx').glob('*access*.log*')):
    if not filename.is_file():continue
    first=None;last=None;lines=0
    opener=gzip.open if filename.suffix=='.gz' else open
    with opener(filename,'rt',errors='replace') as f:
        for line in f:
            lines+=1
            if not any(day in line for day in valid_days):continue
            historical=not any(day in line for day in [(NOW-datetime.timedelta(days=d)).strftime('%d/%b/%Y') for d in [0,1]])
            if historical and '/api/admin/' not in line and '/api/wallet/admin/' not in line:continue
            match=regex.match(line)
            if not match:
                unparsed+=1;continue
            ip,t,method,uri,code,size,referer,ua=match.groups()
            ts=date_cache.get(t)
            if ts is None:
                try: ts=datetime.datetime.strptime(t,'%d/%b/%Y:%H:%M:%S %z').timestamp()
                except ValueError:unparsed+=1;continue
                date_cache[t]=ts
            first=first or t;last=t
            if 'WG-Owner-Security-Readonly-20261014' in ua:own+=1;continue
            path=clean_path(uri);e=entry(ip,t,method,uri,code,ua)
            if ts>=PATCH and legacy_re.match(path):group_add(legacy,e)
            if ts>=PATCH and method not in ['GET','HEAD','OPTIONS'] and (path.startswith('/api/admin/') or path.startswith('/api/wallet/admin/')):
                group_add(highrisk,e);sensitive_samples.append(e)
            if ts<SINCE:continue
            total+=1;status[code]+=1;paths[(method,path,code)]+=1;ips[ip]+=1
            minute=datetime.datetime.fromtimestamp(ts,ZONE).strftime('%Y-%m-%d %H:%M')
            hours[minute[:13]]+=1;minutes[minute]+=1;ipminutes[(ip,minute)]+=1
            if ts>=TODAY:today_total+=1;today_status[code]+=1
            decoded=urllib.parse.unquote(uri)
            if scan_re.search(decoded):group_add(scans,e)
            if code=='429':group_add(ratelimited,e)
            if int(code)>=500:group_add(errors,e)
            if path in ['/api/admin/login','/api/agent/login','/api/wallet/admin/session']:group_add(adminlogins,e)
    source_files.append({'path':str(filename),'bytes':filename.stat().st_size,'lines_examined':lines,'first_selected':first,'last_selected':last})
def ordered(groups):return sorted(groups.values(),key=lambda e:(-e['count'],e['last']))
out.update(total_requests_24h=total,statuses_24h=dict(status),today_requests=today_total,today_statuses=dict(today_status),hourly_requests=dict(sorted(hours.items())),top_minutes=[{'minute':k,'count':v} for k,v in minutes.most_common(10)],top_ip_minutes=[{'ip':k[0],'minute':k[1],'count':v} for k,v in ipminutes.most_common(10)],top_ips=[{'ip':k,'count':v} for k,v in ips.most_common(20)],top_paths=[{'method':k[0],'path':k[1],'status':int(k[2]),'count':v} for k,v in paths.most_common(50)],scan_groups=ordered(scans)[:180],highrisk_writes_since_funds_patch=ordered(highrisk)[:250],legacy_funds_requests_since_patch=ordered(legacy)[:150],admin_login_groups_24h=ordered(adminlogins)[:100],rate_limit_groups=ordered(ratelimited)[:100],server_error_groups=ordered(errors)[:100],recent_sensitive_requests=list(sensitive_samples),source_files=source_files,unparsed_selected=unparsed,owner_probe_requests_excluded=own)
logs=subprocess.run(['journalctl','-u','ssh','-u','sshd','--since','24 hours ago','--no-pager','-o','json'],capture_output=True,text=True,timeout=25)
ssh=collections.Counter();failips=collections.Counter();accepts=[];failure_samples=collections.deque(maxlen=20)
for line in logs.stdout.splitlines():
    try:r=json.loads(line)
    except Exception:continue
    msg=r.get('MESSAGE','')
    if 'Failed password' in msg or 'Invalid user' in msg or 'authentication failure' in msg:
        ssh['failed_or_invalid']+=1
        m=re.search(r'(?:from |rhost=)([0-9a-fA-F:.]+)',msg)
        if m:failips[m[1]]+=1
        failure_samples.append({'time_beijing':datetime.datetime.fromtimestamp(int(r['__REALTIME_TIMESTAMP'])/1000000,ZONE).isoformat(),'message':msg[:220]})
    elif 'Accepted ' in msg:
        ssh['accepted']+=1
        accepts.append({'time_beijing':datetime.datetime.fromtimestamp(int(r['__REALTIME_TIMESTAMP'])/1000000,ZONE).isoformat(),'message':msg[:220]})
    elif 'preauth' in msg:ssh['preauth_disconnects']+=1
out['ssh']={'counts':dict(ssh),'failure_ips':[{'ip':k,'count':v} for k,v in failips.most_common(10)],'accepted_logins':accepts[-100:],'recent_failures':list(failure_samples),'journal_exit':logs.returncode}
sshd=subprocess.run(['sshd','-T'],capture_output=True,text=True,timeout=10)
out['ssh_configuration']=[s for s in sshd.stdout.splitlines() if s.split(' ')[0] in ['passwordauthentication','permitrootlogin','pubkeyauthentication','maxauthtries','maxstartups','allowusers','allowgroups','kbdinteractiveauthentication']]
firewall=subprocess.run(['ufw','status'],capture_output=True,text=True,timeout=10)
out['firewall']={'code':firewall.returncode,'output':firewall.stdout[:5000]}
print(json.dumps(out,ensure_ascii=False,separators=(',',':')))
