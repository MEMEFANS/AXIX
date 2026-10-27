const fs=require('fs');
for(const root of ['resources/app','tools/team-pro-display-20261019/candidate']){
const p=root+'/src/a-token-team-service.js';let s=fs.readFileSync(p,'utf8');
s=s.replace("  const reportingTxs = reportingExclusions === null ? null : new Set(reportingExclusions.transactionHashes.map(k));",`  if (reportingExclusions !== null && (!Array.isArray(reportingExclusions.transactionHashes) || !Array.isArray(reportingExclusions.viewers)
    || !reportingExclusions.transactionHashes.every(hash => /^0x[0-9a-f]{64}$/i.test(hash))
    || !reportingExclusions.viewers.every(addr => /^0x[0-9a-f]{40}$/i.test(addr)))) {
    throw new Error('Invalid Pro reporting exclusions configuration');
  }
  const reportingTxs = reportingExclusions === null ? null : new Set(reportingExclusions.transactionHashes.map(k));`);
s=s.replace("    const hiddenTeam = hiddenViewerSet.has(k(address)) ? hiddenRotationSubtreeCounts(downlines) : { mini: 0, pro: 0, users: 0 };",`    const hiddenTeam = hiddenViewerSet.has(k(address)) ? hiddenRotationSubtreeCounts(downlines) : { mini: 0, pro: 0, users: 0 };
    const hiddenDirect = reportingTxs && hiddenViewerSet.has(k(address)) ? hiddenRotationSubtreeCounts(directWalletSet) : { pro: 0 };`);
s=s.replace('      directPro: realDirectPro + statsAcc.dDirectPro,','      directPro: Math.max(0, realDirectPro + statsAcc.dDirectPro - hiddenDirect.pro),');
s=s.replace('// 轮换收款地址（逗号分隔，含套餐专属格式 \'2:0x..\'）的激活属后台写入的虚拟数据：','// 轮换收款地址（逗号分隔，含套餐专属格式 \'2:0x..\'）用于展示统计排除：');
s=s.replace('// 上级看到的激活矿机台数：轮换收款地址激活的矿机不计入（虚拟数据）','// 按查看者的展示统计规则扣除指定激活，不修改矿机记录。');fs.writeFileSync(p,s);
}
