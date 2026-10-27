import fs from 'node:fs';
import {JsonRpcProvider} from '/opt/wg-platform/node_modules/ethers/lib.esm/index.js';
const data=JSON.parse(fs.readFileSync(0,'utf8').replace(/^\uFEFF/,''));
const main='0xa71e0cfb92643ccf1fadcd45fcfb29b7b39c56e6';
const rotation=new Set(['0x0c89b9ddc29f3e4ac968a3e02611bd95a2df1361']);
const providers=[new JsonRpcProvider('https://bsc-dataseed.bnbchain.org'),new JsonRpcProvider('https://bsc-dataseed1.bnbchain.org')];
const checkpoint='/tmp/aix-daily-activation-20261019-progress.json';
const results=fs.existsSync(checkpoint)?JSON.parse(fs.readFileSync(checkpoint,'utf8')):[];
async function check(row){
 for(const p of providers){
  try{
   const t=await p.getTransaction(row.txHash);if(!t?.to)continue;
   if(t.from.toLowerCase()!==row.wallet.toLowerCase())return {...row,error:'Payment sender mismatch'};
   const value=row.plan==='1'?2000000000000000n:50000000000000000n;
   if(t.value!==value)return {...row,error:'Payment amount mismatch'};
   return {...row,to:t.to.toLowerCase(),value:t.value.toString()};
  }catch{}
 }
 return {...row,error:'Transaction lookup unavailable'};
}
for(let i=results.length;i<data.rows.length;i+=5){results.push(...await Promise.all(data.rows.slice(i,i+5).map(check)));fs.writeFileSync(checkpoint,JSON.stringify(results));}
for(const p of providers)p.destroy();
const out={start:data.start,cutoff:data.cutoff,confirmedCounts:data.rawCounts,mainAddress:main,plans:{'1':{included:0,rotation:0,unknown:0},'2':{included:0,rotation:0,unknown:0}},byRecipient:{},errors:[]};
for(const row of results){
 if(row.error){out.errors.push({id:row.id,txHash:row.txHash,error:row.error});out.plans[row.plan].unknown++;continue;}
 const k=row.plan+':'+row.to;out.byRecipient[k]=(out.byRecipient[k]||0)+1;
 if(rotation.has(row.to))out.plans[row.plan].rotation++;
 else if(row.to===main)out.plans[row.plan].included++;
 else{out.plans[row.plan].unknown++;out.errors.push({id:row.id,txHash:row.txHash,to:row.to,error:'Additional collection address requires classification'});}
}
fs.writeFileSync('/tmp/aix-daily-activation-20261019-evidence.json',JSON.stringify({summary:out,transactions:results}));
console.log(JSON.stringify(out));
