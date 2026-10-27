const fs=require('fs'),path=require('path');
function patch(file, transform){for(const root of ['resources/app','tools/team-pro-display-20261019/baseline']){let s=fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n');const result=transform(s);const dest=root==='resources/app'?path.join(root,file):path.join('tools/team-pro-display-20261019/candidate',file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,result);}}
function replace(s,old,next){if(!s.includes(old))throw Error('Missing: '+old.slice(0,100));return s.replace(old,next);}
patch('src/a-token-team-service.js',s=>{
s=replace(s,"rotationHideViewers = '' })","rotationHideViewers = '', reportingExclusions = null })");
s=replace(s,"  const hiddenViewerSet = new Set(String(rotationHideViewers || '').split(',')",`  const reportingTxs = reportingExclusions === null ? null : new Set(reportingExclusions.transactionHashes.map(k));
  const reportingViewers = reportingExclusions === null ? rotationHideViewers : reportingExclusions.viewers.join(',');
  const hiddenViewerSet = new Set(String(reportingViewers || '').split(',')`);
s=replace(s,'    const map = new Map();\n    for (const addr of hiddenRotationSet) {',`    const map = new Map();
    // A verified transaction list overrides the expected collection address stored at submit time.
    if (reportingTxs) {
      const proWallets = database.listATokenMinerWalletsByPlan('pro1500');
      for (const hash of reportingTxs) {
        const row = database.getATokenActivationByTx(hash);
        if (row?.status === 'confirmed' && String(row.plan) === '2' && proWallets.has(k(row.wallet))) {
          map.set(k(row.wallet), { mini: 0, pro: 1 });
        }
      }
      _hiddenActByWallet = map;
      _hiddenActBuiltAt = now;
      return map;
    }
    for (const addr of hiddenRotationSet) {`);
s=replace(s,"    const acc = { mini: 0, pro: 0 };\n    if (!downlines?.size) return acc;",`    const acc = { mini: 0, pro: 0, users: 0 };
    if (!downlines?.size) return acc;
    const miniWallets = reportingTxs ? database.listATokenMinerWalletsByPlan('mini120') : null;`);
s=replace(s,'      if (downlines.has(w)) { acc.mini += c.mini; acc.pro += c.pro; }',`      if (downlines.has(w)) {
        acc.mini += c.mini; acc.pro += c.pro;
        // A member with a visible Mini miner still counts as an activated member.
        acc.users += reportingTxs ? (miniWallets.has(w) ? 0 : 1) : c.mini + c.pro;
      }`);
s=replace(s,'  function hiddenMinerCountFor(wallet) {',`  function hiddenMinerCountFor(wallet, viewer) {
    if (reportingTxs) return hiddenViewerSet.has(k(viewer)) ? (hiddenActivationsByWallet().get(k(wallet))?.pro || 0) : 0;`);
s=replace(s,'hiddenMinerCountFor(item.wallet)),','hiddenMinerCountFor(item.wallet, address)),');
s=replace(s,"    const { mini, pro } = planMinerWallets();\n    const ak = k(address);\n    const childrenMap = stats.childrenMap;",`    const { mini, pro: rawPro } = planMinerWallets();
    const hidden = reportingTxs && hiddenViewerSet.has(k(address)) ? hiddenActivationsByWallet() : new Map();
    const pro = new Set([...rawPro].filter(w => !hidden.has(w)));
    const hiddenPro = [...stats.downlines].filter(w => rawPro.has(w) && hidden.has(w)).length;
    const hiddenDirectPro = [...stats.directSet].filter(w => rawPro.has(w) && hidden.has(w)).length;
    const ak = k(address);
    const childrenMap = stats.childrenMap;`);
s=replace(s,'      teamMini: stats.teamMini, teamPro: stats.teamPro,\n      directMini: stats.directMini, directPro: stats.directPro,',`      teamMini: stats.teamMini, teamPro: stats.teamPro - hiddenPro,
      directMini: stats.directMini, directPro: stats.directPro - hiddenDirectPro,
      rawTeamPro: stats.teamPro, excludedRotationPro: hiddenPro,`);
s=replace(s,"      netPro: stats.teamPro - s(excludedRows, 'pro'),","      netPro: stats.teamPro - hiddenPro - s(excludedRows, 'pro'),");
s=replace(s,'    const r = realTeamStats(address, links);\n    const real = {',`    const r = realTeamStats(address, links);
    const hiddenTeam = reportingTxs && hiddenViewerSet.has(k(address)) ? hiddenRotationSubtreeCounts(r.downlines) : { pro: 0 };
    const hiddenDirect = reportingTxs && hiddenViewerSet.has(k(address)) ? hiddenRotationSubtreeCounts(r.directSet) : { pro: 0 };
    const real = {`);
s=replace(s,'      directPro: real.directPro + acc.dDirectPro,','      directPro: Math.max(0, real.directPro + acc.dDirectPro - hiddenDirect.pro),');
s=replace(s,'      teamPro: real.teamPro + acc.dTeamPro + ownDirectPro,','      teamPro: Math.max(0, real.teamPro + acc.dTeamPro + ownDirectPro - hiddenTeam.pro),');
s=replace(s,": { mini: 0, pro: 0 };\n\n    // 团队持币",": { mini: 0, pro: 0, users: 0 };\n\n    // 团队持币");
s=replace(s,'- hiddenTeam.mini - hiddenTeam.pro),','- hiddenTeam.users),');
s=replace(s,'  return { snapshot, snapshotAll, getLevel,',`  // Admin display totals use the union of the selected teams; nested teams are counted once.
  function reportingMinerSummary() {
    const raw = database.adminMinerSummary();
    if (!reportingTxs) return raw;
    const links = database.listReferralLinks();
    const eligible = new Set();
    for (const viewer of hiddenViewerSet) for (const w of realTeamStats(viewer, links).downlines) eligible.add(w);
    const rows = raw.rows.map(row => ({ ...row }));
    let excludedPro = 0;
    for (const w of hiddenActivationsByWallet().keys()) {
      if (!eligible.has(w)) continue;
      const miner = database.listATokenMiners(w).filter(row => row.plan === 'pro1500')
        .sort((a, b) => Number(a.startedAt) - Number(b.startedAt) || String(a.id).localeCompare(String(b.id)))[0];
      if (!miner) continue;
      const group = rows.find(row => row.plan === 'pro1500' && row.status === miner.status);
      if (group && group.c > 0) { group.c -= 1; excludedPro += 1; }
    }
    const by = Object.fromEntries(rows.map(row => [\x60\x24{row.status || 'unknown'}:\x24{row.plan || 'all'}\x60, Number(row.c)]));
    return { ...raw, rows, by, total: raw.total - excludedPro, excludedPro, rawTotal: raw.total, rawBy: raw.by };
  }

  return { reportingMinerSummary, snapshot, snapshotAll, getLevel,`);
return s;
});
patch('src/a-token-admin-api.js',s=>s.replaceAll('poolService.database?.adminMinerSummary?.() || null','aTokenTeamService?.reportingMinerSummary?.() || poolService.database?.adminMinerSummary?.() || null'));
patch('src/server.js',s=>replace(s,'const aTokenTeamService = createATokenTeamService({ database: walletService.database, walletService, rotationAddresses: aTokenRotationAddresses, rotationHideViewers: aTokenRotationHideViewers });',`const proReportingFile = path.join(DATA_ROOT, 'pro-reporting-exclusions.json');
const proReportingExclusions = fs.existsSync(proReportingFile) ? JSON.parse(fs.readFileSync(proReportingFile, 'utf8')) : null;
const aTokenTeamService = createATokenTeamService({ database: walletService.database, walletService, rotationAddresses: aTokenRotationAddresses, rotationHideViewers: aTokenRotationHideViewers, reportingExclusions: proReportingExclusions });`));
