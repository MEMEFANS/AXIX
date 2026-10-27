const fs = require('node:fs');
const path = require('node:path');
const bases = [path.resolve(__dirname, '../../resources/app'), path.join(__dirname, 'candidate')];
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Expected one matching source block: ' + before.slice(0, 90));
  return source.replace(before, after);
}
for (const base of bases) {
  const activationPath = path.join(base, 'src/a-token-activation-service.js');
  let activation = fs.readFileSync(activationPath, 'utf8');
  activation = replace(activation, '      record.blockNumber = Number(receipt.blockNumber || 0);',
    `      record.blockNumber = Number(receipt.blockNumber || 0);
      // Store the actual recipient only after all chain checks pass; the submitted address is only a quote.
      record.payload = { ...record.payload, verifiedCollectionAddress: to };`);
  fs.writeFileSync(activationPath, activation);

  const databasePath = path.join(base, 'src/database.js');
  let database = fs.readFileSync(databasePath, 'utf8');
  database = replace(database, "lower(json_extract(payload_json,'$.payload.collectionAddress'))=?",
    "lower(COALESCE(json_extract(payload_json,'$.payload.verifiedCollectionAddress'),json_extract(payload_json,'$.payload.collectionAddress')))=?");
  fs.writeFileSync(databasePath, database);

  const teamPath = path.join(base, 'src/a-token-team-service.js');
  let team = fs.readFileSync(teamPath, 'utf8');
  team = replace(team, "  const reportingTxs = reportingExclusions === null ? null : new Set(reportingExclusions.transactionHashes.map(k));",
    `  if (reportingExclusions?.collectionAddresses !== undefined &&
      (!Array.isArray(reportingExclusions.collectionAddresses) ||
       !reportingExclusions.collectionAddresses.every(addr => /^0x[0-9a-f]{40}$/i.test(addr)))) {
    throw new Error('Invalid Pro reporting collection addresses');
  }
  const reportingCollections = new Set((reportingExclusions?.collectionAddresses || []).map(k));
  const reportingTxs = reportingExclusions === null ? null : new Set(reportingExclusions.transactionHashes.map(k));`);
  const before = `      const proWallets = database.listATokenMinerWalletsByPlan('pro1500');
      for (const hash of reportingTxs) {
        const row = database.getATokenActivationByTx(hash);
        if (row?.status === 'confirmed' && String(row.plan) === '2' && proWallets.has(k(row.wallet))) {
          map.set(k(row.wallet), { mini: 0, pro: 1 });
        }
      }`;
  const after = `      const proWallets = database.listATokenMinerWalletsByPlan('pro1500');
      const include = row => {
        if (row?.status !== 'confirmed' || String(row.plan) !== '2' || row.paymentAsset === 'AIX' || !proWallets.has(k(row.wallet))) return;
        const hasBnbMiner = database.listATokenMiners(row.wallet).some(miner =>
          miner.plan === 'pro1500' && !String(miner.activationId || '').startsWith('ata_aix_'));
        if (hasBnbMiner) map.set(k(row.wallet), { mini: 0, pro: 1 });
      };
      for (const hash of reportingTxs) include(database.getATokenActivationByTx(hash));
      // New payments join the historical list only when their actual chain recipient was verified.
      for (const address of reportingCollections) {
        for (const row of database.listConfirmedATokenActivationsByCollection?.(address) || []) {
          if (k(row.payload?.verifiedCollectionAddress) === address) include(row);
        }
      }`;
  // Production and working copies can retain different line endings.
  const eol = team.includes('\r\n') ? '\r\n' : '\n';
  team = replace(team, before.replaceAll('\n', eol), after.replaceAll('\n', eol));
  team = replace(team, '    return { real, effective, stored };',
    `    const reportingEnabled = !!reportingTxs && hiddenViewerSet.has(k(address));
    const reporting = { enabled: reportingEnabled,
      excludedTeamPro: hiddenTeam.pro, excludedDirectPro: hiddenDirect.pro,
      realTeamPro: Math.max(0, real.teamPro - hiddenTeam.pro),
      realDirectPro: Math.max(0, real.directPro - hiddenDirect.pro),
      excludedDirectWallets: reportingEnabled ? [...r.directSet].filter(wallet => hiddenActivationsByWallet().has(k(wallet))) : [],
    };
    return { real, effective, stored, reporting };`);
  fs.writeFileSync(teamPath, team);
}
console.log('Updated only activation verification, collection lookup, and scoped reporting in working and BNB candidate sources');
