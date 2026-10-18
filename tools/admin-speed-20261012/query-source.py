import base64
import gzip
import hashlib
import json
import pathlib

root=pathlib.Path('/opt/wg-platform')
names=['src/server.js','src/wallet-service.js','src/a-token-admin-api.js','src/lottery-admin-api.js','src/lottery-service.js','public/js/operator-admin.js','public/js/admin-lottery.js','public/admin.html']
out={}
for name in names:
    if (root/name).is_file():
        data=(root/name).read_bytes()
        out[name]={'sha256':hashlib.sha256(data).hexdigest(),'gzip_base64':base64.b64encode(gzip.compress(data)).decode()}
print(json.dumps(out,separators=(',',':')))
