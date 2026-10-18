import base64
import gzip
import pathlib

audit = pathlib.Path(__file__).resolve().parent
payload = base64.b64encode(gzip.compress((audit / 'release-payload.json').read_bytes())).decode('ascii')
source = (audit / 'deploy-template.py').read_text(encoding='utf-8').replace('__PAYLOAD__',payload)
compile(source,'deploy-release.py','exec')
(audit / 'deploy-release.py').write_text(source,encoding='utf-8')
print('Prepared guarded deployment script:',len(source),'bytes')
