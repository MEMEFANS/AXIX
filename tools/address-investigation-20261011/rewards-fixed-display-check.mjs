import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createPlatformService } from '../../resources/app/src/platform-service.js';
import { createATokenRevenueService } from '../../resources/app/src/a-token-revenue-service.js';
import { splitStakePayment } from '../../resources/app/src/a-token-income.js';
import { readAdminAixIncome } from '../../resources/app/src/a-token-admin-income.js';
const {parseUnits,formatUnits}=createRequire(new URL('../../resources/app/package.json',import.meta.url))('ethers');
const s=JSON.parse(fs.readFileSync(new URL('./rewards-audit-data.json',import.meta.url)));
const dataRoot=fs.mkdtempSync(path.join(os.tmpdir(),'aix-display-audit-'));
const realNow=Date.now;Date.now=()=>Date.parse(s.captured_at_utc);
const users=new Map(s.users.map(r=>[r.wallet,r]));
const accounts=new Map(s.platform_accounts.map(r=>[r.wallet,r.payload]));
const locks=new Map;
for(const r of s.tables.a_token_orders.filter(r=>r.status==='OPEN')){
 const key=r.wallet.toLowerCase(),v=locks.get(key)??{aUnits:0n,usdtUnits:0n};v.aUnits+=BigInt(r.input_a_units);v.usdtUnits+=BigInt(r.input_usdt_units);locks.set(key,v);
}
const grouped={};
for(const t of ['a_token_miner_releases','a_token_stake_rewards','a_token_team_rewards','a_token_direct_count_rewards','a_token_miners','a_token_stakes']){
 const index=new Map;for(const r of s.tables[t]){const key=(r.wallet??r.recipient_wallet).toLowerCase();const rows=index.get(key)??[];rows.push(r);index.set(key,rows);}grouped[t]=index;
}
const byWallet=(t,w)=>grouped[t].get(w.toLowerCase())??[];
const db={
 hasPlatformData:()=>true,
 loadPlatformState:()=>({version:4,accounts:{},orders:[],fills:[],audit:[],...s.settings.platform_meta}),
 loadPlatformAccount:w=>accounts.has(w.toLowerCase())?structuredClone(accounts.get(w.toLowerCase())):null,
 replacePlatformState:()=>{},
 sumATokenLockedByWallet:w=>locks.get(w.toLowerCase()),
 platformRecords:()=>[],listAiRewards:()=>[],listATokenTradesByWallet:()=>[],listLotteryWins:()=>[],walletRecords:()=>[],
 listATokenMiners:w=>byWallet('a_token_miners',w).map(r=>structuredClone(r.payload)),
 listATokenStakes:w=>byWallet('a_token_stakes',w).map(r=>structuredClone(r.payload)),
 db:{prepare:sql=>({all:w=>{
   const t=/FROM ([a-z_]+)/i.exec(sql)[1],owner=t==='a_token_team_rewards'||t==='a_token_direct_count_rewards'?'recipient_wallet':'wallet';
   return byWallet(t,w).map(({payload,...r})=>({...r,payload_json:JSON.stringify(payload)})).sort((a,b)=>(a.released_at??a.settled_at??a.created_at)-(b.released_at??b.settled_at??b.created_at)||a.id.localeCompare(b.id));
 }})},
};
const walletService={database:db,balanceUnits:(w,asset)=>BigInt(users.get(w.toLowerCase())?.balances?.[asset]??'0')};
const out={capture:s.captured_at_utc,users_checked:0,AIX_row_mismatches:[],income_summary_mismatches:[],admin_summary_mismatches:[],AIX_total_equity_mismatches:[],classification_mismatches:[],stake_principal_units_excluded_from_balance_row:'0',today_lottery:{},AI_rewards:{}};
try{
 const platform=createPlatformService({dataRoot,walletService});
 const price=parseUnits(s.settings.a_token_pool_meta.priceUsdt,6);
 const revenue=createATokenRevenueService({database:db});
 const nodes=new Map;for(const id of ['assets-table-body','assets-total-equity','assets-spot-value','assets-allocation'])nodes.set(id,{innerHTML:'',textContent:''});
 const context={window:{},document:{getElementById:id=>nodes.get(id)??null,querySelector:()=>null,addEventListener:()=>{}},console,Date,setTimeout,clearTimeout};
 vm.createContext(context);vm.runInContext(fs.readFileSync(new URL('../../resources/app/public/js/assets.js',import.meta.url),'utf8'),context);
 for(const [w,u] of users){
  const free=BigInt(u.balances.A||'0'),lock=locks.get(w)?.aUnits??0n;
  platform.setATokenPriceProvider(()=>0n);const without=platform.profile(w,{});
  platform.setATokenPriceProvider(()=>price);const profile=platform.profile(w,{});
  const held=byWallet('a_token_stakes',w).reduce((sum,r)=>sum+splitStakePayment(r.payload,r.total_earned_units).outstanding,0n);
  const expectedSpot=free*price/10n**18n+lock*price/10n**18n;
  const expectedStake=held*price/10n**18n;
  const expectedValue=expectedSpot+expectedStake;
  const difference=parseUnits(profile.account.totalEquity,6)-parseUnits(without.account.totalEquity,6);
  if(difference!==expectedValue)out.AIX_total_equity_mismatches.push(w);
  if(parseUnits(profile.spot.A,18)!==free||parseUnits(profile.spotFrozen.A,18)!==lock)out.AIX_row_mismatches.push(w);
  if(parseUnits(profile.account.spotValue,6)-parseUnits(without.account.spotValue,6)!==expectedSpot||parseUnits(profile.account.stakingValue,6)-parseUnits(without.account.stakingValue,6)!==expectedStake)out.classification_mismatches.push(w);
  context.window.ExchangeAssets.renderPlatform({...profile,symbols:['BTC','ETH','BNB'],marketPrices:{A:Number(s.settings.a_token_pool_meta.priceUsdt)}});
  const row=nodes.get('assets-table-body').innerHTML.match(/<tr>(?:(?!<\/tr>)[\s\S])*?<b>AIX<\/b>(?:(?!<\/tr>)[\s\S])*?<\/tr>/)?.[0];
  assert(row,'AIX asset row missing');
  const amounts=[...row.matchAll(/<td>(?:<span class="assets-total-amount">)?([\d,]+\.\d{2})/g)].map(x=>x[1]);
  const rounded=v=>Number(formatUnits(v,18)).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  if(amounts[0]!==rounded(free+lock)||amounts[1]!==rounded(free)||amounts[2]!==rounded(lock))out.AIX_row_mismatches.push({wallet:w,amounts,expected:[rounded(free+lock),rounded(free),rounded(lock)]});
  const result=revenue.listRevenue(w,{limit:1});
  const miner=byWallet('a_token_miner_releases',w).reduce((v,r)=>v+BigInt(r.amount_units),0n);
  const team=byWallet('a_token_team_rewards',w).reduce((v,r)=>v+BigInt(r.amount_units),0n);
  const direct=byWallet('a_token_direct_count_rewards',w).reduce((v,r)=>v+BigInt(r.amount_units),0n);
  let interest=0n,principal=0n;const paid=new Map,stakeById=new Map(byWallet('a_token_stakes',w).map(r=>[r.id,r.payload]));
  for(const r of byWallet('a_token_stake_rewards',w).slice().sort((a,b)=>a.settled_at-b.settled_at||a.id.localeCompare(b.id))){
   const amount=BigInt(r.amount_units),before=paid.get(r.stake_id)??0n,st=stakeById.get(r.stake_id);
   let p=r.payload.principalUnits!=null?BigInt(r.payload.principalUnits):0n;
   if(r.payload.principalUnits==null&&st){const legacy={...st,principalReturnedUnits:undefined,interestEarnedUnits:undefined};p=splitStakePayment(legacy,before+amount).principal-splitStakePayment(legacy,before).principal;}
   const i=r.payload.interestUnits!=null?BigInt(r.payload.interestUnits):amount-p;
   interest+=i;principal+=p;paid.set(r.stake_id,before+amount);
  }
  if(parseUnits(result.total,18)!==miner+interest+team+direct||parseUnits(result.stats.stake,18)!==interest||parseUnits(result.stats.principalReturned,18)!==principal)out.income_summary_mismatches.push(w);
  const admin=readAdminAixIncome(db,w);
  if(admin.teamRewards.count!==byWallet('a_token_team_rewards',w).length||parseUnits(admin.teamRewards.total,18)!==team||parseUnits(admin.minerTotalReleased,18)!==miner||parseUnits(admin.stakes.totalEarned,18)!==interest||parseUnits(admin.stakes.principalReturned,18)!==principal)out.admin_summary_mismatches.push(w);
  out.users_checked++;
 }
 let held=0n;for(const r of s.tables.a_token_stakes)held+=splitStakePayment(r.payload,r.total_earned_units).outstanding;
 out.stake_principal_units_excluded_from_balance_row=held.toString();
 for(const r of s.tables.lottery_wins.filter(r=>r.created_at>=s.day_start_ms)){
  const key=r.symbol||r.prize_type,v=out.today_lottery[key]??{count:0,amount_units:0n};v.count++;
  if(r.symbol==='AIX'||r.symbol==='USDT')v.amount_units+=parseUnits(String(r.amount),r.symbol==='AIX'?18:6);
  out.today_lottery[key]=v;
 }
 const ai=s.tables.ai_managed_rewards.filter(r=>r.created_at>=s.day_start_ms);
 out.AI_rewards={credited_USDT:formatUnits(ai.filter(r=>!r.payload.kind&&!r.payload.status).reduce((v,r)=>v+BigInt(r.amount_units),0n),6),pending_referral_USDT:formatUnits(ai.filter(r=>r.payload.kind==='referral'&&r.payload.status==='pending').reduce((v,r)=>v+BigInt(r.amount_units),0n),6)};
 fs.writeFileSync(new URL('./rewards-fixed-display-result.json',import.meta.url),JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2));
 console.log(JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2));
 for(const [name,value] of Object.entries(out))if(name.endsWith('_mismatches'))assert.equal(value.length,0,name);
}finally{Date.now=realNow;fs.rmSync(dataRoot,{recursive:true,force:true});}
