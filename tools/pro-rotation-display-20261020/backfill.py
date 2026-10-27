import datetime, json, pathlib, sqlite3, subprocess
stage = pathlib.Path('/root/wg-pro-rotation-display-20261020')
source = pathlib.Path('/var/lib/wg-platform/pro-reporting-exclusions.json')
config = json.loads(source.read_text())
since = int(datetime.datetime.fromisoformat(config['verifiedAt'].replace('Z','+00:00')).timestamp()*1000)-3600000
with sqlite3.connect('file:/var/lib/wg-platform/wg-platform.sqlite?mode=ro',uri=True) as db:
    rows = [json.loads(row[0]) for row in db.execute("SELECT payload_json FROM a_token_activations WHERE plan='2' AND status='confirmed' AND confirmed_at>=?",(since,))]
cache = stage/'chain-check.json'
known = {item['hash']:item for item in json.loads(cache.read_text())['transactions'] if not item.get('error')} if cache.exists() else {}
unchecked = [row for row in rows if row['txHash'] not in known]
program = r'''
import {JsonRpcProvider} from 'ethers';
import fs from 'node:fs';
const rows=JSON.parse(fs.readFileSync(0,'utf8'));
const providers=['https://bsc-dataseed.bnbchain.org','https://bsc-dataseed1.bnbchain.org'].map(url=>new JsonRpcProvider(url));
const recipients=new Set(['0x1266d38865460cf7d0c06985ac5587a5e85de2c0','0x0c89b9ddc29f3e4ac968a3e02611bd95a2df1361']);
const output=[];
for(let i=0;i<rows.length;i+=4)output.push(...await Promise.all(rows.slice(i,i+4).map(async row=>{
  for(const provider of providers)try{
    const [tx,receipt]=await Promise.all([provider.getTransaction(row.txHash),provider.getTransactionReceipt(row.txHash)]);
    if(!tx||receipt?.status!==1||String(tx.from).toLowerCase()!==String(row.wallet).toLowerCase()||tx.value!==5n*10n**16n)throw new Error('Transaction validation mismatch');
    return {hash:row.txHash,to:tx.to.toLowerCase(),rotation:recipients.has(tx.to.toLowerCase())};
  }catch(error){if(provider===providers.at(-1))return {hash:row.txHash,error:String(error.shortMessage||error.message).slice(0,150)};}
})));
for(const provider of providers)provider.destroy();
console.log(JSON.stringify(output));
'''
result = subprocess.run(['node','--input-type=module','-e',program],cwd=stage/'candidate',input=json.dumps(unchecked),capture_output=True,text=True,timeout=210)
if result.returncode:
    raise RuntimeError(result.stderr[-1200:])
transactions = [known[row['txHash']] for row in rows if row['txHash'] in known] + json.loads(result.stdout)
errors = [item for item in transactions if item.get('error')]
(stage/'chain-check.json').write_text(json.dumps({'since':since,'checked':len(rows),'transactions':transactions,'errors':errors}))
assert not errors, 'Chain checks failed: '+json.dumps(errors[:3])
config['version'] = 2
config['collectionAddresses'] = ['0x1266d38865460cf7d0c06985ac5587a5e85de2c0','0x0c89b9ddc29f3e4ac968a3e02611bd95a2df1361']
original_hashes = set(config['transactionHashes'])
config['transactionHashes'] = sorted(original_hashes|{item['hash'].lower() for item in transactions if item['rotation']})
config['dynamicVerifiedRecipients'] = True
config['updatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
(stage/'candidate/pro-reporting-exclusions.json').write_text(json.dumps(config,indent=2))
print(json.dumps({'checked':len(rows),'rotationPaymentsFound':sum(item['rotation'] for item in transactions),
                  'additionalHistoricalHashes':len(config['transactionHashes'])-len(original_hashes),'totalHashes':len(config['transactionHashes'])}))
