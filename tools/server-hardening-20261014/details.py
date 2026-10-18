import pathlib,subprocess,json,os,tempfile,sqlite3
def run(a):
 p=subprocess.run(a,capture_output=True,text=True,timeout=20)
 return {'code':p.returncode,'out':p.stdout[:10000],'err':p.stderr[:300]}
r=pathlib.Path('/opt/wg-platform')
out={}
out['unit_safe']='\n'.join(l if not l.lstrip().startswith(('Environment=','SetCredential=','SetCredentialEncrypted=')) else l.split('=')[0]+'=[redacted]' for l in pathlib.Path('/etc/systemd/system/wg-platform.service').read_text().splitlines())
out['nginx_site']=pathlib.Path('/etc/nginx/sites-enabled/axix.cc.conf').read_text()
out['links']=run(['find',str(r),'-maxdepth','3','-type','l','-printf','%p -> %l\n'])
out['processes']=run(['bash','-c',"pgrep -af 'deploy|hardening|apt-get|dpkg|wg-platform' | head -25"])
out['cron_paths']=run(['bash','-c',"grep -Rln '/opt/wg-platform' /etc/cron* /etc/systemd/system /var/spool/cron/crontabs 2>/dev/null | head -40"])
out['readwrite_sources']=run(['bash','-c',"grep -nE 'readFile|writeFile|dataRoot|mkdir' /opt/wg-platform/src/database.js | head -35"])
out['data_override_process']=run(['bash','-c',"pid=$(systemctl show wg-platform -p MainPID --value); tr '\\0' '\\n' < /proc/$pid/environ | grep '^WG_DATA_DIR=' || true"])
with tempfile.TemporaryDirectory(prefix='wg-sqlite-link-') as td:
 d=pathlib.Path(td); (d/'real').mkdir(); (d/'old').mkdir()
 a=sqlite3.connect(d/'real'/'test.db'); a.execute('PRAGMA journal_mode=WAL'); a.execute('create table test(v)'); a.execute('insert into test values(1)'); a.commit()
 (d/'old'/'test.db').symlink_to(d/'real'/'test.db')
 b=sqlite3.connect(d/'old'/'test.db'); b.execute('insert into test values(2)'); b.commit()
 out['sqlite_symlink']={'rows':a.execute('select * from test').fetchall(),'wal_in_real':(d/'real'/'test.db-wal').exists(),'wal_in_old':(d/'old'/'test.db-wal').exists()}
 b.close();a.close()
print(json.dumps(out,ensure_ascii=False))
