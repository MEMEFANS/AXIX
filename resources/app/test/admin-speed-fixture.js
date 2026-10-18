import { openDatabase, closeDatabase } from '../src/database.js';

export const USER_COUNT = 7223;
export const fixtureWallet = index => '0x' + (index + 1).toString(16).padStart(40, '0');

export function seedAdminSpeedFixture(root) {
  const database = openDatabase(root);
  const started = Date.UTC(2026, 9, 1);
  const iso = index => new Date(started + index * 1000).toISOString();
  const users = Object.fromEntries(Array.from({length:USER_COUNT}, (_, index) => {
    const address = fixtureWallet(index);
    return [address, {address, balances:{USDT:String(BigInt(index + 1) * 1_000001n), A:index === USER_COUNT - 1 ? '1000000000000000000' : '0'}, createdAt:iso(index), updatedAt:iso(index), level:index % 10 + 1}];
  }));
  const deposits = Array.from({length:18}, (_, index) => ({id:'speed-deposit-' + index, txHash:'0x' + (index + 1).toString(16).padStart(64, '0'), wallet:fixtureWallet(index), network:'bsc', asset:'USDT', amountUnits:String(BigInt(index + 1) * 1_000001n), status:'confirmed', createdAt:iso(index), confirmedAt:iso(index + 10)}));
  deposits.push({id:'speed-pending', txHash:'0x' + 'f'.repeat(64), wallet:fixtureWallet(20), network:'bsc', asset:'USDT', amountUnits:'1000000', status:'pending', createdAt:iso(20)});
  const withdrawals = Array.from({length:12}, (_, index) => ({id:'speed-withdrawal-' + index, requestId:'speed-request-' + index, wallet:fixtureWallet(index), network:'bsc', asset:'USDT', amountUnits:'1000000', status:index === 0 ? 'pending_review' : index === 1 ? 'pending_auto' : 'paid', createdAt:iso(index)}));
  database.replaceWalletState({version:5, users, deposits, withdrawals, sessions:{}, withdrawalFrozen:{}, withdrawalAutomation:{enabled:true, reviewThresholdUnits:'10000000', dailyLimitUnits:'1000000000', usdtMultipleOfTen:false, updatedAt:iso(0)}});
  database.transaction(() => {
    for (let index = 0; index < USER_COUNT - 3; index++) database.upsertATokenMinerRow({id:'speed-miner-' + index, wallet:fixtureWallet(index), plan:'mini120', totalUnits:'120000000000000000000', dailyRateBps:100, dailyTargetUnits:'1000000000000000000', startedAt:started, expiresAt:started + 86400000, lastReleaseAt:started, dayEarnedUnits:'0', totalEarnedUnits:'0', status:'completed'});
    database.upsertATokenStakeRow({id:'speed-stake', wallet:fixtureWallet(USER_COUNT - 3), planId:'fixture', principalUnits:'1000000000000000000', dailyRateBps:100, startedAt:started, expiresAt:started + 86400000, lastSettledAt:started, dayEarnedUnits:'0', totalEarnedUnits:'0', status:'active'});
  });
  closeDatabase(root);
}
