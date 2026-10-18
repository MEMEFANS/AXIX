import base64
import gzip
import json
import pathlib

root = pathlib.Path(__file__).resolve().parent
payload = json.loads((root / 'deploy-payload.json').read_text(encoding='utf-8'))
packed = base64.b64encode(gzip.compress(json.dumps(payload).encode('utf-8'))).decode('ascii')
source = (root / 'deploy-template.py').read_text(encoding='utf-8')
assert source.count('__PAYLOAD__') == 1
source = source.replace('__PAYLOAD__', packed)
compile(source, 'deploy-generated.py', 'exec')
(root / 'deploy-generated.py').write_text(source, encoding='utf-8')
print('Validated deployment script generated: ' + str(len(source)) + ' characters')
