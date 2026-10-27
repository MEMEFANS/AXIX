import fs from 'node:fs';
import assert from 'node:assert/strict';
import {openDatabase,closeDatabase} from './src/database.js';
import {createATokenTeamService as candidate} from './src/a-token-team-service.js';
import {createATokenTeamService as baseline} from './baseline/src/a-token-team-service.js';
const db=openDatabase('./data');
const config=JSON.parse(fs.readFileSync('./pro-reporting-exclusions.json','utf8'));
const walletService={balanceUnits:wallet=>BigInt(JSON.parse(db.db.prepare('SELECT balances_json FROM wallet_users WHERE address=? COLLATE NOCASE').get(wallet)?.balances_json||'{}').A||'0')};
const args={database:db,walletService,rotationAddresses:config.collectionAddress,rotationHideViewers:config.viewers.join(',')};
const old=baseline(args),next=candidate({...args,reportingExclusions:config});
const original={};for(const table of ['wallet_users','a_token_miners','a_token_activations','a_token_team_rewards','a_token_miner_releases'])original[table]=JSON.stringify(db.db.prepare('SELECT * FROM '+table+' ORDER BY 1').all());
const result={teams:{}};
for(const root of config.viewers){
 const raw=next.getTeamStatsView(root).real;const before=old.profile(root),after=next.profile(root);const breakdown=next.teamActivationBreakdown(root);
 assert.equal(breakdown.teamPro,raw.teamPro-breakdown.excludedRotationPro);assert.equal(next.getTeamStatsView(root).effective.teamPro,after.teamPro);
 assert.equal(after.teamMini,before.teamMini);assert.equal(after.realLevel,before.realLevel);assert.equal(after.teamHoldA,before.teamHoldA);assert.equal(after.totalEarnedA,before.totalEarnedA);
 result.teams[root]={rawPro:raw.teamPro,previousDisplayPro:before.teamPro,displayPro:after.teamPro,excludedPro:breakdown.excludedRotationPro,mini:after.teamMini,previousMinerUsers:before.teamMinerUsers,minerUsers:after.teamMinerUsers};
}
const chosen=config.transactionHashes.map(tx=>db.getATokenActivationByTx(tx));
for(const a of chosen){assert.equal(a.status,'confirmed');assert.equal(String(a.plan),'2');}
const outside=chosen[0].wallet;assert.equal(next.profile(outside).teamPro,old.profile(outside).teamPro,'Unselected team Pro count is unchanged');
result.admin=next.reportingMinerSummary();assert.equal(result.admin.excludedPro,Object.values(result.teams).reduce((m,t)=>Math.max(m,t.excludedPro),0));
for(const table in original)assert.equal(JSON.stringify(db.db.prepare('SELECT * FROM '+table+' ORDER BY 1').all()),original[table],table+' changed');
closeDatabase('./data');fs.writeFileSync('./production-copy-results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
