import json,gzip,base64,hashlib
files=['src/lottery-service.js','src/a-token-api.js','src/withdrawal-payout-service.js','public/js/admin-lottery.js','public/js/admin-community.js','public/admin.html']
data={}
for f in files:
    body=open('/opt/wg-platform/'+f,'rb').read()
    data[f]={'sha256':hashlib.sha256(body).hexdigest(),'body':base64.b64encode(gzip.compress(body)).decode()}
print(json.dumps(data))
