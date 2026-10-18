const fs=require('fs');
const root='tools/address-investigation-20261011';
const s=JSON.parse(fs.readFileSync(root+'/rewards-audit-data.json'));
const day=s.day_start_ms, now=Date.parse(s.captured_at_utc),D=86400000,off=28800000;
const B=v=>BigInt(v??'0'),w=v=>String(v??'').toLowerCase(),bj=t=>Math.floor((Number(t)+off)/D)*D-off;
const fmt=n=>{n=B(n);const a=n/10n**18n,b=(n%10n**18n).toString().padStart(18,'0').replace(/0+$/,'');return a+(b?'.'+b:'.0');};
const tables=s.tables;
const miners=new Map(tables.a_token_miners.map(m=>[m.id,m]));
const stakes=new Map(tables.a_token_stakes.map(m=>[m.id,m]));
const issues={};const add=(name,item)=>{(issues[name]??=[]).push(item);};
function groupSum(rows,key,amount='amount_units'){const m=new Map;for(const r of rows)m.set(r[key],(m.get(r[key])??0n)+B(r[amount]));return m;}
const minerSums=groupSum(tables.a_token_miner_releases,'miner_id'),stakeSums=groupSum(tables.a_token_stake_rewards,'stake_id');
const today={};for(const [t,rows] of Object.entries(tables)){
 const list=rows.filter(r=>Number(r.released_at??r.settled_at??r.created_at??0)>=day);
 if(list.length)today[t]={count:list.length,amount_A:t.startsWith('a_token_')?fmt(list.reduce((v,r)=>v+B(r.amount_units),0n)):undefined};
}
const plans={current:{days:0,bps:30},s30:{days:30,bps:80},s60:{days:60,bps:100},s90:{days:90,bps:120}};
const todayMinerGroups=new Map;
for(const m of miners.values()){
 if(B(m.total_earned_units)!==(minerSums.get(m.id)??0n))add('miner_lifetime_ledger_mismatch',{id:m.id,wallet:m.wallet,state:m.total_earned_units,rows:(minerSums.get(m.id)??0n).toString()});
 if(B(m.total_earned_units)>B(m.total_units))add('miner_over_total',m.id);
 if(m.status==='active'&&Number(m.started_at)<day&&Number(m.last_release_at)<day)add('miner_overdue',{id:m.id,wallet:m.wallet,last:m.last_release_at,started:m.started_at});
 if(m.payload.totalEarnedUnits!==m.total_earned_units||m.payload.lastReleaseAt!==m.last_release_at)add('miner_payload_mismatch',m.id);
}
for(const r of tables.a_token_miner_releases){
 if(r.released_at<day)continue;const m=miners.get(r.miner_id);if(!m){add('orphan_miner_release',r.id);continue;}
 const amount=B(r.amount_units),elapsed=r.payload.elapsedMs;
 if(elapsed!=null){const expected=B(m.daily_target_units)*B(elapsed)/B(D);if(amount!==expected)add('miner_today_amount_mismatch',{id:r.id,amount:amount.toString(),expected:expected.toString(),elapsed});}
 if(r.payload.amountUnits!=null&&r.payload.amountUnits!==r.amount_units)add('release_payload_amount_mismatch',r.id);
 const key=r.miner_id+'|'+bj(r.released_at);const rows=todayMinerGroups.get(key)??[];rows.push(r);todayMinerGroups.set(key,rows);
}
for(const [key,rows] of todayMinerGroups)if(rows.length>1&&!rows.some(r=>r.payload.reason==='final'))add('miner_today_duplicate',{key,ids:rows.map(r=>r.id)});
let stakeInterest=0n,stakePrincipal=0n;
for(const m of stakes.values()){
 if(B(m.total_earned_units)!==(stakeSums.get(m.id)??0n))add('stake_lifetime_ledger_mismatch',{id:m.id,wallet:m.wallet,state:m.total_earned_units,rows:(stakeSums.get(m.id)??0n).toString()});
 const plan=plans[m.plan_id];const first=bj(m.started_at)+(Number(m.started_at)===bj(m.started_at)?0:D);
 if(m.status==='active'&&first+D<=day&&Number(m.last_settled_at)<day)add('stake_overdue',{id:m.id,wallet:m.wallet,first,started:m.started_at,last:m.last_settled_at});
 if(plan?.days&&B(m.total_earned_units)>B(m.principal_units)*(10000n+B(plan.bps*plan.days))/10000n)add('stake_over_total',m.id);
 if(m.payload.totalEarnedUnits!==m.total_earned_units||m.payload.lastSettledAt!==m.last_settled_at)add('stake_payload_mismatch',m.id);
}
for(const r of tables.a_token_stake_rewards){
 if(r.settled_at<day)continue;const m=stakes.get(r.stake_id),p=r.payload,plan=plans[m?.plan_id];
 if(!m||!plan){add('orphan_stake_reward',r.id);continue;}
 const principal=B(p.principalUnits),interest=B(p.interestUnits);
 if(p.principalUnits==null||p.interestUnits==null)add('stake_missing_split',r.id);
 else if(principal+interest!==B(r.amount_units))add('stake_split_mismatch',r.id);
 stakeInterest+=interest;stakePrincipal+=principal;
 if(p.reason!=='final'){
  const expectedI=B(m.principal_units)*B(plan.bps)/10000n;
  const expectedP=plan.days?B(m.principal_units)/B(plan.days):0n;
  if(interest!==expectedI||principal!==expectedP)add('stake_today_amount_mismatch',{id:r.id,principal:principal.toString(),interest:interest.toString(),expectedP:expectedP.toString(),expectedI:expectedI.toString()});
 }
}
const minerSources=new Map(tables.a_token_miner_releases.map(r=>[r.miner_id+'|'+r.released_at,r]));
const stakeSources=new Map(tables.a_token_stake_rewards.map(r=>[r.stake_id+'|'+(r.payload.periodEndAt??r.settled_at),r]));
const parents=new Map(tables.platform_referral_links.map(r=>[w(r.wallet),r]));
function chain(address,time){const out=[],visited=new Set([w(address)]);let link=parents.get(w(address));while(link?.referrer_wallet&&out.length<10&&Number(link.created_at)<=time){const next=parents.get(w(link.referrer_wallet));if(!next||visited.has(w(next.wallet)))break;visited.add(w(next.wallet));out.push(w(next.wallet));link=next;}return out;}
const eligibleAt=(address,time)=>tables.a_token_miners.some(m=>w(m.wallet)===w(address)&&Number(m.started_at)<=time)||tables.a_token_stakes.some(m=>w(m.wallet)===w(address)&&Number(m.started_at)<=time)||tables.a_token_activations.some(m=>w(m.wallet)===w(address)&&m.status==='confirmed'&&Number(m.confirmed_at??m.created_at)<=time);
const teamUnique=new Map,teamGroups=new Map,teamKinds={};
for(const r of tables.a_token_team_rewards){
 if(r.created_at<day)continue;const kind=r.kind;teamKinds[kind]??={count:0,units:0n};teamKinds[kind].count++;teamKinds[kind].units+=B(r.amount_units);
 if(!/^(miner|stake)_(direct|indirect|team|level_diff)$/.test(kind))continue;
 const match=r.id.slice(kind.length+1).match(/^(.*)_(\d+)_(\d+)$/);
 if(!match){add('team_unknown_key',r.id);continue;}
 const sourceId=match[1],period=Number(match[2]),isMiner=kind.startsWith('miner_');
 const source=(isMiner?minerSources:stakeSources).get(sourceId+'|'+period);
 if(!source){add('team_missing_source',{id:r.id,sourceId,period});continue;}
 const base=B(isMiner?source.amount_units:source.payload.interestUnits??source.amount_units),expected=base*B(r.rate_bps)/10000n;
 if(B(r.amount_units)!==expected)add('team_amount_mismatch',{id:r.id,sourceId,base:base.toString(),rate:r.rate_bps,actual:r.amount_units,expected:expected.toString()});
 if(w(r.source_wallet)!==w(source.wallet))add('team_source_wallet_mismatch',r.id);
 if(!eligibleAt(r.recipient_wallet,r.created_at))add('ineligible_team_recipient',r.id);
 const lineage=chain(source.wallet,r.created_at),recipient=w(r.recipient_wallet);
 if((kind.endsWith('_direct')&&recipient!==lineage[0])||(kind.endsWith('_indirect')&&recipient!==lineage[1])||!lineage.includes(recipient))add('team_wrong_ancestor',{id:r.id,recipient,lineage});
 const unique=sourceId+'|'+period+'|'+kind+'|'+recipient;
 if(teamUnique.has(unique))add('team_today_duplicate',{ids:[teamUnique.get(unique),r.id]});teamUnique.set(unique,r.id);
 const group=sourceId+'|'+period,rows=teamGroups.get(group)??[];rows.push(r);teamGroups.set(group,rows);
}
for(const [key,rows] of teamGroups){
 const first=rows[0],isMiner=first.kind.startsWith('miner_');const source=(isMiner?minerSources:stakeSources).get(key);if(!source)continue;
 const lineage=chain(source.wallet,first.created_at),base=B(isMiner?source.amount_units:source.payload.interestUnits??source.amount_units);
 for(const [i,suffix,rate] of [[0,'direct',1500n],[1,'indirect',1000n]])if(lineage[i]&&eligibleAt(lineage[i],first.created_at)&&base*rate/10000n>0n&&!rows.some(r=>r.kind===(isMiner?'miner_':'stake_')+suffix&&w(r.recipient_wallet)===lineage[i]))add('missing_direct_indirect',{source:key,kind:suffix,wallet:lineage[i]});
}
// Check sources that have no team rows at all as well.
for(const [kind,sources] of [['miner',tables.a_token_miner_releases],['stake',tables.a_token_stake_rewards]])for(const source of sources){
 const time=source.released_at??source.settled_at;if(time<day)continue;
 const key=(source.miner_id??source.stake_id)+'|'+(kind==='miner'?time:source.payload.periodEndAt??time);
 if(teamGroups.has(key))continue;const lineage=chain(source.wallet,time);
 const base=B(kind==='miner'?source.amount_units:source.payload.interestUnits??source.amount_units);
 if(lineage.slice(0,2).some((a,i)=>eligibleAt(a,time)&&base*B(i?1000:1500)/10000n>0n))add('source_missing_team_distribution',{kind,source:key,lineage:lineage.slice(0,2)});
}
const totalsByKind=Object.fromEntries(Object.entries(teamKinds).map(([k,v])=>[k,{count:v.count,amount:fmt(v.units)}]));
const output={captured_at_utc:s.captured_at_utc,day_start_beijing:s.day_start_beijing,today,stake_interest:fmt(stakeInterest),stake_principal_returned:fmt(stakePrincipal),team_by_kind:totalsByKind,issue_counts:Object.fromEntries(Object.entries(issues).map(([k,v])=>[k,v.length])),issues};
fs.writeFileSync(root+'/rewards-analysis.json',JSON.stringify(output,null,2));
console.log(JSON.stringify({...output,issues:Object.fromEntries(Object.entries(issues).map(([k,v])=>[k,v.slice(0,5)]))},null,2));
