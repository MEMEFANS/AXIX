import pathlib,json,base64,shutil,subprocess,sqlite3
r=pathlib.Path('/opt/wg-platform');s=pathlib.Path('/tmp/aix-pro-display-20261019')
for folder in ['src','test']:
 shutil.copytree(r/folder,s/folder,dirs_exist_ok=True)
shutil.copytree(r/'src',s/'baseline/src',dirs_exist_ok=True)
(s/'baseline/package.json').write_text('{"type":"module"}')
(s/'package.json').write_text('{"type":"module"}')
if not (s/'node_modules').exists():(s/'node_modules').symlink_to(r/'node_modules',target_is_directory=True)
if not (s/'baseline/node_modules').exists():(s/'baseline/node_modules').symlink_to(r/'node_modules',target_is_directory=True)
for f,b in json.loads((s/'payload.json').read_text(encoding='utf-8-sig')).items():
 p=s/f;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(base64.b64decode(b))
for f in ['src/a-token-team-service.js','src/a-token-admin-api.js','src/server.js']:
 subprocess.run(['node','--check',str(s/f)],check=True,capture_output=True)
out={}
for t in ['a-token-pro-reporting.test.js','a-token-team-loading.test.js','a-token-ecosystem.test.js']:
 p=subprocess.run(['node','test/'+t],cwd=s,capture_output=True,text=True,timeout=90)
 out[t]={'passed':p.returncode==0,'output':(p.stdout+p.stderr)[-1800:]}
 if p.returncode:print(json.dumps(out,ensure_ascii=False));raise SystemExit(1)
d=s/'data';d.mkdir(exist_ok=True)
with sqlite3.connect('file:/var/lib/wg-platform/wg-platform.sqlite?mode=ro',uri=True) as source,sqlite3.connect(d/'wg-platform.sqlite') as target:source.backup(target)
(s/'test-results.json').write_text(json.dumps(out,ensure_ascii=False,indent=2))
print(json.dumps(out,ensure_ascii=False))
