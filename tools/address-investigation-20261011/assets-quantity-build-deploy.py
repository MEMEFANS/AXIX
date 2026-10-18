import base64
import gzip
import hashlib
import json
import pathlib

root = pathlib.Path(__file__).parent
payload = json.loads((root / 'assets-quantity-fix/deploy-payload.json').read_text(encoding='utf-8'))
for name, item in payload['files'].items():
    data = (root / 'assets-quantity-fix/production-candidate' / name.removeprefix('public/')).read_bytes()
    assert hashlib.sha256(data).hexdigest() == item['after'], name
    assert base64.b64decode(item['body']) == data, name
packed = base64.b64encode(gzip.compress(json.dumps(payload).encode('utf-8'))).decode('ascii')
template = (root / 'assets-quantity-deploy-template.py').read_text(encoding='utf-8')
assert template.count('__PAYLOAD__') == 1
generated = template.replace('__PAYLOAD__', packed)
compile(generated, 'assets-quantity-deploy-generated.py', 'exec')
(root / 'assets-quantity-deploy-generated.py').write_text(generated, encoding='utf-8')
print('Validated deployment script generated: ' + str(len(generated)) + ' characters')
