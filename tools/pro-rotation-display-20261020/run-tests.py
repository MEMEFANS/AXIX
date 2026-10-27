import json, pathlib, subprocess
stage=pathlib.Path('/root/wg-pro-rotation-display-20261020')
names=['a-token-pro-reporting.test.js','a-token-pro-rotation-reporting.test.js','a-token-pro-recipient.test.js',
       'a-token-reconcile.test.js','a-token-team-loading.test.js','a-token-ecosystem.test.js','a-token-income.test.js']
out={}
for name in names:
 result=subprocess.run(['node','test/'+name],cwd=stage/'candidate',capture_output=True,text=True,timeout=90)
 out[name]={'passed':result.returncode==0,'tail':(result.stdout+result.stderr)[-1200:]}
 (stage/'test-results.json').write_text(json.dumps(out))
 if result.returncode:raise RuntimeError(json.dumps({name:out[name]}))
print(json.dumps({'passed':len(out),'tests':{name:result['passed'] for name,result in out.items()}}))
