const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const roots = ['resources/app', 'tools/pro-rotation-display-20261020/candidate'];
const address = n => '0x' + n.toString(16).padStart(40, '0');
const viewer = address(1), outsider = address(2);
const hidden = address(3), mixed = address(4), visible = address(5), hiddenCompleted = address(6);
const links = [viewer, outsider].map(wallet => ({wallet})).concat([hidden, mixed, visible, hiddenCompleted].map(wallet => ({wallet, referrerWallet: viewer})));
const miner = (id, wallet, plan, status, startedAt) => ({id, wallet, plan, status, startedAt, activationId:id==='mixed-aix'?'ata_aix_pro_1':undefined, totalUnits:'0', totalEarnedUnits:'0', dayEarnedUnits:'0', dailyTargetUnits:'0'});
const miners = [miner('hidden', hidden, 'pro1500', 'active', 1), miner('mixed-old', mixed, 'pro1500', 'completed', 1), miner('mixed-aix', mixed, 'pro1500', 'active', 0), miner('mixed-mini', mixed, 'mini120', 'active', 0), miner('visible', visible, 'pro1500', 'active', 3), miner('completed', hiddenCompleted, 'pro1500', 'completed', 1)];
const activations = miners.filter(m => m.plan === 'pro1500').map(m => ({id:m.id, wallet:m.wallet, plan:'2', status:'confirmed'}));
const raw = JSON.stringify({miners, activations});
const db = {
  getATokenTeamLevel:()=>({}), listReferralLinks:()=>links,
  listATokenMiners:wallet=>miners.filter(m=>m.wallet===wallet),
  listATokenActivationsByWallet:wallet=>activations.filter(a=>a.wallet===wallet),
};
const reporting = {enabled:true, excludedDirectPro:2, excludedTeamPro:2, realDirectPro:2, realTeamPro:2, excludedDirectWallets:[hidden, mixed, hiddenCompleted]};
const teamView = wallet => ({
  real:{directCount:4, indirectCount:0, teamCount:4, directMini:1, teamMini:1, directPro:4, teamPro:4},
  effective:{directCount:4, indirectCount:0, teamCount:4, directMini:1, teamMini:1, directPro:wallet===viewer?3:4, teamPro:wallet===viewer?3:4},
  stored:null,
  reporting:wallet===viewer?reporting:{enabled:false, excludedDirectWallets:[], realDirectPro:0, realTeamPro:0},
});

function between(source, start, end) {
  const a=source.indexOf(start), b=source.indexOf(end,a+start.length);
  assert(a>=0&&b>a, 'Source boundary not found');
  return source.slice(a,b);
}

(async()=>{
  const results=[];
  for(const root of roots){
    for(const file of ['src/server.js','public/js/operator-admin.js']){
      const result=spawnSync(process.execPath,['--check',root+'/'+file],{encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
    }
    const source=fs.readFileSync(root+'/src/server.js','utf8');
    const handlerSource=between(source,"      if (p.startsWith('/api/admin/users/') && p.endsWith('/detail')",'      // 设置用户等级');
    const handle = new Function('p','request','res','walletService','formatUnits','A_TOKEN_DECIMALS','aTokenService','readAdminAixIncome','aTokenTeamService','aTokenOrderService','aTokenTransferService','send',handlerSource);
    const renderSource=between(fs.readFileSync(root+'/public/js/operator-admin.js','utf8'),'  function renderUserDetail(d) {','  function renderDeposits() {');
    const render=new Function('esc','amount','date','shortAddress','emptyRow',renderSource+'\nreturn renderUserDetail;')(String,String,String,String,()=>'<tr></tr>');
    const run=wallet=>{
      const res={};
      handle('/api/admin/users/'+wallet+'/detail',{method:'GET'},res,
        {database:db,ensureUser:()=>({balances:{USDT:'0'}})},String,18,{balanceA:()=>0n},()=>({minerTotalReleased:'0',minerReleases:[],stakes:{},stakeRewards:[],teamRewards:{}}),
        {getTeamStatsView:teamView},{myOrders:()=>[]},{myTransfers:()=>[]},(r,status,data)=>Object.assign(r,{status,data}));
      assert.equal(res.status,200,JSON.stringify(res.data));
      return res.data;
    };
    const d=run(viewer);
    assert.equal(d.direct.realActPro,2);
    assert.equal(d.team.realActPro,2);
    assert.equal(d.direct.actPro,3,'Virtual display increment remains included');
    assert.equal(d.statsOverride.real.directPro,4,'Raw audit data remains untouched');
    assert.equal(d.statsOverride.real.teamPro,4);
    const rows=new Map(d.direct.list.map(row=>[row.wallet,row]));
    assert.equal(rows.get(hidden).hasPro,false);
    assert.equal(rows.get(hidden).minerCount,0);
    assert.equal(rows.get(hidden).activeMinerCount,0);
    assert.equal(rows.get(mixed).hasPro,true,'Another Pro miner remains visible');
    assert.equal(rows.get(mixed).minerCount,2,'Mini and AIX Pro remain visible');
    assert.equal(rows.get(mixed).activeMinerCount,2,'Earlier AIX miner must not be excluded instead of completed BNB miner');
    assert.equal(rows.get(hiddenCompleted).minerCount,0);
    assert.equal(rows.get(visible).hasPro,true);
    assert.equal(rows.get(visible).minerCount,1);
    const html=render(d);
    const proEditorFields=html.match(/<span>[^<]*Pro[^<]*<small>[^<]*<\/small><\/span>/g)||[];
    const proStats=html.match(/<span>[^<]*Pro[^<]*：<b>[^<]*<\/b>/g)||[];
    assert.equal(proEditorFields.length,2);
    assert.equal(proStats.length,2);
    for(const field of proEditorFields)assert(field.includes('真实 2 人')&&!field.includes('真实 4'),'Pro editor must use filtered baseline');
    for(const stat of proStats)assert(stat.includes('3 人（真实 2）')&&!stat.includes('真实 4'),'Pro stats must use filtered comparison');
    const ordinary=run(outsider);
    ordinary.statsOverride.real={directPro:4,teamPro:4};
    ordinary.direct.actPro=ordinary.team.actPro=5;
    assert(render(ordinary).includes('真实 4 人'),'Other viewer retains original audit comparison');
    assert.equal(JSON.stringify({miners,activations}),raw,'All detail queries are read only');
    const admin=fs.readFileSync(root+'/public/admin.html','utf8');
    assert.match(admin,/operator-admin\.js\?v=20261020-(?:aix-)?pro-rotation-1/);
    const settingsSource=between(source,"      if (p.startsWith('/api/admin/users/') && p.endsWith('/team-stats')",'      // 冻结/解冻指定账户');
    const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
    const saveSettings=new AsyncFunction('p','request','res','allowRequest','readBody','walletService','aTokenTeamService','operatorSession','send','console',settingsSource);
    const settingsDefaults={directCount:4,indirectCount:0,teamCount:4,directMini:1,teamMini:1};
    async function save(wallet,inputPro){
      const res={};let stored=null;
      const settingsDb={upsertATokenTeamStatsOverride:row=>(stored=row),deleteATokenTeamStatsOverride:()=>{stored=null;}};
      const view=()=>{
        const target=wallet===viewer;
        const baseline=target?2:4;
        const directDelta=stored?.dDirectPro||0;
        const teamDelta=stored?.dTeamPro||0;
        return {real:{...settingsDefaults,directPro:4,teamPro:4},reporting:{enabled:target,realDirectPro:2,realTeamPro:2},effective:{directPro:baseline+directDelta,teamPro:baseline+directDelta+teamDelta}};
      };
      await saveSettings('/api/admin/users/'+wallet+'/team-stats',{method:'POST'},res,()=>true,async()=>({...settingsDefaults,directPro:inputPro,teamPro:inputPro}),{database:settingsDb},{getTeamStatsView:view},{username:'test'},(r,status,data)=>Object.assign(r,{status,data}),{log(){}});
      assert.equal(res.status,200,JSON.stringify(res.data));
      return res.data;
    }
    const unchanged=await save(viewer,2);
    assert.equal(unchanged.override.dDirectPro,0);
    assert.equal(unchanged.override.dTeamPro,0);
    assert.equal(unchanged.view.effective.directPro,2,'Saving displayed direct Pro total must not deduct exclusions twice');
    assert.equal(unchanged.view.effective.teamPro,2,'Saving displayed team Pro total must not deduct exclusions twice');
    const targetIncrement=await save(viewer,3);
    assert.equal(targetIncrement.override.dDirectPro,1,'Target Pro increments use filtered baseline');
    assert.equal(targetIncrement.override.dTeamPro,1);
    const ordinaryIncrement=await save(outsider,5);
    assert.equal(ordinaryIncrement.override.dDirectPro,1,'Other viewer retains raw baseline formula');
    assert.equal(ordinaryIncrement.override.dTeamPro,1);
    for(const field of ['dDirect','dIndirect','dTeam','dDirectMini','dTeamMini'])assert.equal(targetIncrement.override[field],0,'Other display fields retain original formulas');
    results.push({root,syntax:true,scopedDetails:true,rawDataPreserved:true,multipleProAndMini:true,earlierAixMinerPreserved:true,activeStatusAccurate:true,renderedProBaseline:true,cacheVersion:true,saveUsesFilteredProBaseline:true,unchangedSavePreservesTotals:true,otherViewerUsesRawBaseline:true});
  }
  const candidate='tools/pro-rotation-display-20261020/';
  const baseline=fs.readFileSync(candidate+'baseline/src/server.js','utf8');
  const final=fs.readFileSync(candidate+'candidate/src/server.js','utf8');
  const originalSettings=between(baseline,'      // 设置团队展示数据','      // 冻结/解冻指定账户');
  const updatedSettings=between(final,'      // 设置团队展示数据','      // 冻结/解冻指定账户');
  const expectedSettings=originalSettings.replace('const { real } =','const { real, reporting } =')
    .replace('inputs.directPro - real.directPro','inputs.directPro - (reporting?.enabled ? reporting.realDirectPro : real.directPro)')
    .replace('inputs.teamPro - real.teamPro','inputs.teamPro - (reporting?.enabled ? reporting.realTeamPro : real.teamPro)');
  assert.equal(updatedSettings,expectedSettings,'Only Pro display baseline calculation may change in settings handler');
  fs.writeFileSync(candidate+'admin-detail-check.json',JSON.stringify({passed:true,results,onlyProDisplaySettingBaselineChanged:true},null,2)+'\n');
  console.log(JSON.stringify({passed:true,results,onlyProDisplaySettingBaselineChanged:true}));
})().catch(error=>{console.error(error);process.exitCode=1;});
