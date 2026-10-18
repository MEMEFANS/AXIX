import base64
import gzip
import hashlib
import json
import pathlib
import shutil
import sqlite3
import subprocess

root = pathlib.Path('/opt/wg-platform')
backup = root / 'backups/admin-security-20261011-013513'
copy = backup / 'diagnostic-isolated'
copy.mkdir(mode=0o700)
shutil.copy2(backup / 'before.sqlite',copy / 'wg-platform.sqlite')
code = r"""
import {createWalletService} from './src/wallet-service.js';
import {closeDatabase} from './src/database.js';
const dataRoot=process.argv[1];
try {
 const service=createWalletService({dataRoot,depositAddress:'0x'+'d'.repeat(40),networks:[]});
 try {const records=service.adminListBalanceAdjustments(200);console.log(JSON.stringify({isolated:true,ok:true,count:records.length}));}
 catch(error) {console.log(JSON.stringify({isolated:true,ok:false,name:error.name,code:error.code,message:String(error.message).slice(0,300)}));}
}finally {closeDatabase(dataRoot);}
"""
probe = subprocess.run(['node','--input-type=module','-e',code,str(copy)],cwd=root,check=True,capture_output=True,text=True,timeout=30)
db = sqlite3.connect('file:' + str(backup / 'before.sqlite') + '?mode=ro',uri=True)
invalid = []
count = 0
for id,amount,payload in db.execute('SELECT id,amount_units,payload_json FROM balance_adjustments ORDER BY created_at DESC LIMIT 200'):
    count += 1
    item = json.loads(payload)
    value = item.get('amountUnits')
    if not isinstance(value,str) or not value.lstrip('-').isdigit():
        invalid.append({'id':id,'column_amount_valid':isinstance(amount,str) and amount.lstrip('-').isdigit(),'payload_keys':sorted(item.keys()),'payload_units_type':type(value).__name__,'type':item.get('type')})
db.close()
data = (root / 'src/database.js').read_bytes()
print(json.dumps({'probe':json.loads(probe.stdout),'count':count,'invalid':invalid,'database_source':{'sha256':hashlib.sha256(data).hexdigest(),'gzip_base64':base64.b64encode(gzip.compress(data)).decode('ascii')}}))
