import assert from 'node:assert/strict';
import {createATokenTeamService} from '../src/a-token-team-service.js';
import {createATokenAdminApi} from '../src/a-token-admin-api.js';
const addr = n => '0x' + n.toString(16).padStart(40,'0');
const tx = n => '0x' + n.toString(16).padStart(64,'0');
const [top, nested, paid, dual, mainPaid, outsider, outsidePaid] = [1,2,3,4,5,6,7].map(addr);
const links = [[top,null],[nested,top],[paid,nested],[dual,nested],[mainPaid,nested],[outsider,null],[outsidePaid,outsider]].map(([wallet,referrerWallet])=>({wallet,referrerWallet}));
const miners = [[paid,'pro1500','active'],[dual,'pro1500','active'],[dual,'mini120','active'],[mainPaid,'pro1500','active'],[outsidePaid,'pro1500','completed']].map(([wallet,plan,status],i)=>({id:String(i),wallet,plan,status,startedAt:i,totalUnits:'1500000000000000000000',totalEarnedUnits:'0'}));
const acts = [paid,dual,mainPaid,outsidePaid].map((wallet,i)=>({id:String(i),wallet,plan:'2',status:'confirmed',txHash:tx(i+1),payload:{collectionAddress:addr(99)}}));
const original=JSON.stringify({miners,acts});
let level={level:0};
const db={
 db:{prepare:()=>({all:()=>[]})},listReferralLinks:()=>links,
 listATokenMinerWalletsByPlan:plan=>new Set(miners.filter(m=>m.plan===plan).map(m=>m.wallet)),
 listATokenMinerWallets:()=>new Set(miners.map(m=>m.wallet)),
 listATokenMiners:w=>miners.filter(m=>m.wallet===w),countATokenMinersByWallet:w=>miners.filter(m=>m.wallet===w).length,
 listATokenStakes:()=>[],listActiveATokenStakes:()=>[],getATokenActivationByTx:t=>acts.find(a=>a.txHash===t),
 listATokenTeamStatsOverrides:()=>[],getATokenTeamLevel:()=>level,upsertATokenTeamLevelRow:r=>{level=r},
 getA10Pool:()=>null,listATokenTeamLevelsByLevel:()=>[],
 adminMinerSummary:()=>({total:5,by:{'active:pro1500':3,'active:mini120':1,'completed:pro1500':1},rows:[{plan:'pro1500',status:'active',c:3},{plan:'mini120',status:'active',c:1},{plan:'pro1500',status:'completed',c:1}]})
};
const walletService={balanceUnits:()=>0n};
const config={viewers:[top,nested],transactionHashes:[tx(1),tx(2),tx(2),tx(4)]};
const team=createATokenTeamService({database:db,walletService,reportingExclusions:config});
for(const viewer of [top,nested]){
 const breakdown=team.teamActivationBreakdown(viewer.toUpperCase());
 assert.equal(breakdown.teamPro,1);assert.equal(breakdown.teamMini,1);assert.equal(breakdown.excludedRotationPro,2);
 assert.equal(breakdown.rawTeamPro,3);assert.equal(breakdown.directRows.reduce((s,r)=>s+r.pro,0),1);
 const view=team.getTeamStatsView(viewer);assert.equal(view.real.teamPro,3);assert.equal(view.effective.teamPro,1);
 const p=team.profile(viewer);assert.equal(p.teamPro,1);assert.equal(p.teamMini,1);assert.equal(p.teamMinerUsers,2,'Dual Mini/Pro user remains visible through Mini');
 assert.equal(p.directPro,viewer===nested?1:0);
}
assert.equal(team.teamActivationBreakdown(outsider).teamPro,1,'Other viewer is unchanged');
assert.equal(team.profile(outsider).teamPro,1);
const excluded=team.teamActivationBreakdown(top,[nested]);assert.equal(excluded.netPro,0);
const summary=team.reportingMinerSummary();assert.equal(summary.excludedPro,2,'Nested teams and repeated tx hashes deduplicate');
assert.equal(summary.total,3);assert.equal(summary.by['active:pro1500'],1);assert.equal(summary.by['active:mini120'],1);assert.equal(summary.by['completed:pro1500'],1);
assert.equal(summary.rawTotal,5);assert.equal(summary.rawBy['active:pro1500'],3);
assert.equal(JSON.stringify({miners,acts}),original,'Display queries preserve source records');
assert.equal(createATokenTeamService({database:db,walletService}).reportingMinerSummary().total,5);
assert.throws(()=>createATokenTeamService({database:db,walletService,reportingExclusions:{viewers:[top],transactionHashes:['bad']}}));
const admin=createATokenAdminApi({aTokenService:{poolStats:()=>({}),getActivationMeta:()=>({})},poolService:{database:db},aTokenTeamService:team,minerService:{presentAll:()=>miners,MINER_PLANS:{}},send:(res,status,data)=>Object.assign(res,{status,data})});
for(const pathname of ['/api/admin/a-token/stats','/api/admin/a-token/miners']){
 const res={};await admin.handle({method:'GET'},res,pathname,{url:new URL('http://test'+pathname)});assert.equal(res.status,200);
 const s=res.data.summary||res.data.miners;assert.equal(s.excludedPro,2);assert.equal(s.by['active:pro1500'],1);
}
console.log('PASS Pro display: scoped teams, nested dedupe, verified transactions, mixed Mini/Pro, untouched source data, both admin endpoints');
