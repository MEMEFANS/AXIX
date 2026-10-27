import pathlib,json,sqlite3,subprocess,os
r=pathlib.Path('/opt/wg-platform');c=sqlite3.connect('file:/var/lib/wg-platform/wg-platform.sqlite?mode=ro',uri=True)
rows=[json.loads(x[0]) for x in c.execute("select payload_json from a_token_activations where status='confirmed' and plan='2' and lower(json_extract(payload_json,'$.payload.collectionAddress'))='0x0c89b9ddc29f3e4ac968a3e02611bd95a2df1361'")]
node="""import {JsonRpcProvider} from 'ethers';
const rows=JSON.parse(process.env.TEAM_AUDIT_TXS); const p=new JsonRpcProvider('https://bsc-dataseed.bnbchain.org');
const results=[];for(let i=0;i<rows.length;i+=5){results.push(...await Promise.all(rows.slice(i,i+5).map(async r=>{try{const t=await p.getTransaction(r.txHash);return {id:r.id,hash:r.txHash,to:t?.to||'',from:t?.from||'',value:t?.value?.toString()||''};}catch(e){return {id:r.id,error:String(e.shortMessage||e.message).slice(0,120)}}})));}p.destroy();console.log(JSON.stringify(results));"""
p=subprocess.run(['node','--input-type=module','-e',node],cwd=r,env={**os.environ,'TEAM_AUDIT_TXS':json.dumps(rows)},capture_output=True,text=True,timeout=90)
if p.returncode:raise RuntimeError(p.stderr[-600:])
print(p.stdout)
