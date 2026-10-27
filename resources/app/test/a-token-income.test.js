import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseUnits } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { closeDatabase } from '../src/database.js';
import { createATokenService } from '../src/a-token-service.js';
import { createATokenTeamService } from '../src/a-token-team-service.js';
import { createATokenMinerService } from '../src/a-token-miner-service.js';
import { createATokenStakingService } from '../src/a-token-staking-service.js';
import { createATokenRevenueService } from '../src/a-token-revenue-service.js';
import { createReferralService } from '../src/referral-service.js';
import { readAixIncome, beijingDayStart } from '../src/a-token-income.js';

const A = x => parseUnits(String(x), 18), DAY = 86400000;
const user = n => '0x' + n.toString(16).padStart(40, '0');
function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aix-income-'));
  let now = beijingDayStart(Date.now());
  const wallet = createWalletService({dataRoot:root, depositAddress:user(999), networks:[]});
  const db = wallet.database;
  const at = createATokenService({database:db, walletService:wallet});
  const team = createATokenTeamService({database:db, walletService:wallet});
  const referrals = createReferralService({database:db, walletService:wallet});
  const stake = createATokenStakingService({database:db, aTokenService:at, teamService:team, clock:()=>now});
  const miner = createATokenMinerService({database:db, aTokenService:at, teamService:team, clock:()=>now});
  const revenue = createATokenRevenueService({database:db});
  const fund = (n, amount) => { wallet.ensureUser(user(n)); if (amount) at.creditA(user(n), A(amount)); return user(n); };
  const link = (child, parent) => referrals.ensure(child, referrals.ensure(parent).code);
  const activate = wallet => db.upsertATokenActivationRow({
    id:'fixture_activation_'+wallet, wallet, plan:'mini120', bnbAmountWei:'1',
    txHash:wallet.padEnd(66,'0'), status:'confirmed', createdAt:now, confirmedAt:now,
  });
  try { run({root,db,at,team,stake,miner,revenue,referrals,wallet,fund,link,activate,now:()=>now,advance:days=>now+=days*DAY}); }
  finally { closeDatabase(root); fs.rmSync(root,{recursive:true,force:true}); }
}

fixture(({db,at,team,stake,revenue,fund,link,activate,advance,now,root}) => {
  const child=fund(1,1000), parent=fund(2), grand=fund(3);
  link(parent,grand); link(child,parent);
  activate(parent); activate(grand);
  const s=stake.stake(child,'s30','1000');
  advance(1); stake.processAll();
  let row=stake.present(child)[0];
  assert.equal(row.interestEarned,'8.0');
  assert.equal(A(row.principalReturned),A(1000)/30n);
  assert.equal(at.balanceA(parent),A('1.2'));
  assert.equal(at.balanceA(grand),A('.8'));
  assert.equal(A(team.profile(parent).teamStakeA),A(1000)-A(1000)/30n);
  assert.equal(A(revenue.listRevenue(child).stats.stake),A(8));
  const paid=at.balanceA(child);
  stake.processAll(); team.distributeStakeReward(child,A(8),s.id,now());
  assert.equal(at.balanceA(child),paid); assert.equal(at.balanceA(parent),A('1.2'));
  advance(10); stake.processAll();
  assert.equal(A(stake.present(child)[0].interestEarned),A(88));
  const todayRows=readAixIncome(db,child,'stake').filter(r=>r.settledAt===now());
  assert.equal(todayRows.length,10,'catch-up records retain actual receipt time');
  advance(19); stake.processAll();
  row=stake.present(child)[0];
  assert.equal(row.status,'completed'); assert.equal(at.balanceA(child),A(1240));
  assert.equal(A(row.principalReturned),A(1000)); assert.equal(A(row.interestEarned),A(240));
  assert.equal(at.balanceA(parent),A(36)); assert.equal(at.balanceA(grand),A(24));
  assert.equal(A(revenue.listRevenue(child).total),A(240),'returned principal is not profit');
  assert.equal(A(revenue.listRevenue(child).stats.principalReturned),A(1000));
  const persisted=JSON.parse(db.db.prepare('SELECT balances_json FROM wallet_users WHERE address=? COLLATE NOCASE').get(child).balances_json);
  assert.equal(BigInt(persisted.A),A(1240));
  closeDatabase(root);
  const reopened=createWalletService({dataRoot:root,depositAddress:user(999),networks:[]});
  assert.equal(reopened.balanceUnits(child,'A'),A(1240),'committed credits survive reopening');
});

// 2026-10-28 改版：起押当天零头也结算——12:00（北京）起押，跨过次日 00:00 即到账半日产出
fixture(({at,stake,fund,advance,db}) => {
  const child=fund(41,2000);
  advance(.5); // 当天 12:00（北京）起押
  stake.stake(child,'s30','1000');
  const before=at.balanceA(child);
  advance(.5); // 次日 00:00（北京）
  stake.processAll();
  const dailyP=A(1000)/30n, dailyI=A(1000)*80n/10000n;
  const grantP=dailyP*43200000n/86400000n, grantI=dailyI*43200000n/86400000n;
  assert.equal(at.balanceA(child)-before, grantP+grantI, '12:00 起押跨 0 点即按半日折算到账');
  assert.equal(readAixIncome(db,child,'stake').length,1,'零头天也一条流水');
  const mid=at.balanceA(child);
  stake.processAll();
  assert.equal(at.balanceA(child),mid,'同刻重复巡检不重复发放');
  advance(1); stake.processAll();
  assert.equal(at.balanceA(child)-mid, dailyP+dailyI, '之后每个北京日整日产出');
});

fixture(({db,at,team,stake,miner,fund,link,activate,advance,now}) => {
  const child=fund(11,2000), parent=fund(12); link(child,parent); activate(parent);
  const s=stake.stake(child,'s30','1000'); const m=miner.createMiner(child,'mini120');
  const before=at.balanceA(child), meta=()=>JSON.stringify(db.db.prepare('SELECT * FROM service_settings WHERE setting_key LIKE ?').all('a_token%'));
  advance(1); const initialMeta=meta();
  const real=team.distributeStakeReward;
  team.distributeStakeReward=(...args)=>{real(...args);throw new Error('injected team failure');};
  // 单笔失败由巡检捕获并留待重试：不抛出、不中断整批，该笔事务全量回滚。
  assert.doesNotThrow(()=>stake.processAll(),'单笔结算失败不应中断整批');
  assert.equal(at.balanceA(child),before); assert.equal(at.balanceA(parent),0n);
  assert.equal(readAixIncome(db,child,'stake').length,0);
  assert.equal(readAixIncome(db,parent,'team').length,0);
  assert.equal(stake.present(child)[0].totalEarnedUnits,'0'); assert.equal(meta(),initialMeta);
  team.distributeStakeReward=real; stake.processAll();
  assert.equal(at.balanceA(parent),A('1.2'));
  const realMiner=team.distributeMinerReward;
  team.distributeMinerReward=()=>{throw new Error('injected miner failure');};
  const preMiner=at.balanceA(child);
  // 单台失败由巡检捕获并留待重试；必须回滚该台余额和流水。
  assert.doesNotThrow(()=>miner.processAll()); assert.equal(at.balanceA(child),preMiner);
  assert.equal(readAixIncome(db,child,'miner').length,0);
  team.distributeMinerReward=realMiner; miner.processAll();
  assert.equal(readAixIncome(db,child,'miner').length,1);
  const recorded=at.balanceA(parent);
  team.distributeMinerReward(child,A(100)/30n,m.id,now()); assert.equal(at.balanceA(parent),recorded);
  assert.equal(db.db.prepare('SELECT started_at FROM a_token_stakes WHERE id=?').get(s.id).started_at,s.startedAt);
});

fixture(({at,team,miner,fund,advance,db}) => {
  const good=fund(16), bad=fund(17);
  const goodMiner=miner.createMiner(good,'mini120');
  miner.createMiner(bad,'mini120');
  advance(1);
  const original=team.distributeMinerReward;
  team.distributeMinerReward=(wallet,...args)=>{
    original(wallet,...args);
    if(wallet===bad) throw new Error('injected later miner failure');
  };
  miner.processAll();
  assert.equal(at.balanceA(good),A(100)/30n,'healthy miner credited once after batch rollback and fallback');
  assert.equal(at.balanceA(bad),0n,'failed miner has no memory credit');
  assert.equal(readAixIncome(db,good,'miner').length,1);
  assert.equal(readAixIncome(db,bad,'miner').length,0);
  assert.equal(BigInt(JSON.parse(db.db.prepare('SELECT balances_json FROM wallet_users WHERE address=? COLLATE NOCASE').get(bad).balances_json).A),0n);
  assert.equal(BigInt(miner.present(good).find(row=>row.id===goodMiner.id).totalEarnedUnits),A(100)/30n);
  team.distributeMinerReward=original;
  miner.processAll();
  assert.equal(at.balanceA(good),A(100)/30n,'retry does not duplicate healthy miner payout');
  assert.equal(at.balanceA(bad),A(100)/30n);
});

fixture(({at,stake,miner,fund,advance,db}) => {
  const child=fund(21,2000);
  stake.stake(child,'s30','1000');
  const other=stake.stake(child,'s30','1000');
  assert.equal(stake.present(child).length,2,'same millisecond deposits remain separate');
  let available=A(2);
  at.creditStakingA=(wallet,requested)=>{const grant=requested<available?requested:available;available-=grant;at.creditA(wallet,grant);return grant.toString();};
  advance(1); stake.processAll();
  const first=stake.present(child).find(s=>s.id!==other.id);
  assert.equal(A(first.principalReturned),A(1000)/30n);
  assert.equal(A(first.interestEarned),A(2));
  advance(1); stake.processAll();
  assert.equal(A(stake.present(child).find(s=>s.id===first.id).principalReturned),2n*(A(1000)/30n),'quota must not alter principal drip');
  advance(28); stake.processAll();
  assert.equal(at.balanceA(child),A(2002),'all deposited principal recoverable with exhausted rewards');
  const balance=at.balanceA(child); stake.processAll(); assert.equal(at.balanceA(child),balance);
  available=A(478); stake.processAll(); assert.equal(at.balanceA(child),A(2480));
  assert.ok(stake.present(child).every(s=>s.status==='completed'));
  miner.createMiner(child,'mini120');
  let minerLeft=A(1); at.creditMinerA=(w,n)=>{const g=n<minerLeft?n:minerLeft;minerLeft-=g;at.creditA(w,g);return g.toString();};
  advance(1); miner.processAll();
  assert.equal(BigInt(readAixIncome(db,child,'miner')[0].amountUnits),A(1));
  assert.equal(A(miner.present(child)[0].totalEarned),A(1));
  advance(.5); assert.equal(A(miner.present(child)[0].totalEarned),A(1),'uncredited estimates stay out of settled total');
});

fixture(({db,revenue,miner,fund,now}) => {
  const child=fund(31); const m=miner.createMiner(child,'mini120');
  const t=beijingDayStart(Date.now())-DAY+1000;
  db.transaction(()=>{
    const insert=db.db.prepare('INSERT INTO a_token_miner_releases VALUES(?,?,?,?,?,?)');
    for(let i=0;i<6001;i++) insert.run('legacy_'+i,m.id,child,'1000000000000000',t+i,JSON.stringify({minerId:m.id}));
  });
  const result=revenue.listRevenue(child,{limit:1});
  assert.equal(result.total,'6.001'); assert.equal(result.stats.yesterday,'6.001');
  assert.equal(result.list[0].createdAt,t+6000);
  assert.equal(result.list[0].detail.includes('6001 笔'),true);
  assert.equal(db.listATokenMinerReleases(child,1)[0].releasedAt,t+6000);
  assert.equal(A(result.total),A(result.stats.miner)+A(result.stats.stake)+A(result.stats.direct)+A(result.stats.team));
});

fixture(({team,referrals,fund,link,at,db,now}) => {
  const parent=fund(41),child=fund(42),grandchild=fund(43);link(child,parent);link(grandchild,child);
  assert.throws(()=>referrals.ensure(parent,referrals.ensure(grandchild).code),/循环/);
  // Isolate pool accounting from level qualification, covered in ecosystem tests.
  const real=db.listATokenTeamLevelsByLevel;
  db.listATokenTeamLevelsByLevel=()=>[{wallet:parent},{wallet:child}];
  const receiptTime=Date.parse('2026-09-10T16:01:00Z'); // Sep 11 Beijing
  team.distributeToA10Pool(A(10)+1n,'trade');
  const credit=at.balanceA(parent);
  const originalInsert=db.insertATokenTeamRewardRow;
  let calls=0; db.insertATokenTeamRewardRow=(row)=>{if(++calls===2)throw new Error('injected pool failure'); return originalInsert(row);};
  assert.throws(()=>team.settleA10Pool(receiptTime),/injected/);
  assert.equal(at.balanceA(parent),credit); assert.equal(BigInt(db.getA10Pool('current').accumUnits),A(10)+1n);
  db.insertATokenTeamRewardRow=originalInsert;
  assert.equal(team.settleA10Pool(receiptTime).settleDate,'2026-09-11');
  assert.equal(at.balanceA(parent)+at.balanceA(child),A(10)+1n);
  team.distributeToA10Pool(A(3),'later-trade');
  assert.equal(team.settleA10Pool(receiptTime+60000).settled,false);
  assert.equal(BigInt(db.getA10Pool('current').accumUnits),A(3),'same-day rerun cannot erase later fees');
  assert.equal(db.listA10PoolHistory().length,1);
  db.listATokenTeamLevelsByLevel=real;
});
console.log('a-token-income tests passed: interest-only, principal conservation, atomic rollback, replay, history, Beijing time, cycles, pool');
