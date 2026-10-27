import pathlib,subprocess,json,os
s=pathlib.Path('/tmp/aix-daily-activation-20261019-verify.mjs');assert s.exists(), 'Verifier missing'
pid=pathlib.Path('/tmp/aix-daily-activation-20261019.pid')
if pid.exists():
 try:os.kill(int(pid.read_text()),0);print('Already running');raise SystemExit(0)
 except ProcessLookupError:pass
with open('/tmp/snapshot.json','rb') as source,open('/tmp/aix-daily-activation-20261019-result.json','wb') as out,open('/tmp/aix-daily-activation-20261019-error.log','wb') as err:
 p=subprocess.Popen(['node','--max-old-space-size=160',str(s)],stdin=source,stdout=out,stderr=err,start_new_session=True)
 pid.write_text(str(p.pid));print(json.dumps({'started':p.pid}))
