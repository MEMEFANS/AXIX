// 一次性运维：立即释放全部 active 矿机 / 质押「一个北京日」的产出到钱包余额
// 原理：以「未来某个北京 00:00」为结算时刻调用 processAll —— 日结只发已完整度过的北京日，
// 幂等键按北京日槽，提前发放后定时器到点不会重复发、也不会跳天。
// 用法：node scripts/release-one-day.mjs [额外提前天数]
//   无参 = 明天北京00:00（释放1天）；传 1 = 后天00:00（在已提前释放基础上再释放1天），以此类推
import { getConfig, DATA_ROOT } from '../src/config.js';
import { createWalletService } from '../src/wallet-service.js';
import { createATokenService } from '../src/a-token-service.js';
import { createATokenTeamService } from '../src/a-token-team-service.js';
import { createATokenMinerService } from '../src/a-token-miner-service.js';
import { createATokenStakingService } from '../src/a-token-staking-service.js';
import { formatUnits } from 'ethers';

const cfg = getConfig();
const walletService = createWalletService({ ...cfg.wallet, dataRoot: DATA_ROOT, withdrawalPrivateKey: cfg.wallet.withdrawalPrivateKey });
const aTokenService = createATokenService({ database: walletService.database, walletService });
const teamService = createATokenTeamService({ database: walletService.database, walletService });
const minerService = createATokenMinerService({ aTokenService, database: walletService.database, teamService });
const stakingService = createATokenStakingService({ aTokenService, database: walletService.database, teamService });
const db = walletService.database;

const DAY_MS = 24 * 60 * 60_000;
const BJ_OFFSET_MS = 8 * 60 * 60_000;
const now = Date.now();
const extraDays = Math.max(0, Number(process.argv[2]) || 0);
// 明天北京 00:00 + 额外提前天数
const settleAt = Math.floor((now + BJ_OFFSET_MS) / DAY_MS) * DAY_MS - BJ_OFFSET_MS + DAY_MS + extraDays * DAY_MS;
const since = settleAt; // 流水时间戳=结算时刻本身，按它过滤只统计本次写入（历史提前释放的时间戳更早）

const sumSince = (table, col) => {
  const row = db.db.prepare(`SELECT COALESCE(SUM(amount_units),'0') AS s FROM ${table} WHERE ${col} >= ?`).get(since);
  return BigInt(row?.s || '0n');
};
const cntActiveMiners = db.db.prepare(`SELECT COUNT(*) AS c FROM a_token_miners WHERE status='active'`).get().c;
const cntActiveStakes = db.db.prepare(`SELECT COUNT(*) AS c FROM a_token_stakes WHERE status='active'`).get().c;

console.log(`结算时刻(北京): ${new Date(settleAt + BJ_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16)} ｜ active 矿机 ${cntActiveMiners} 台 / 质押 ${cntActiveStakes} 单`);

const minerTouched = minerService.processAll(settleAt);
const stakeTouched = stakingService.processAll(settleAt);

// 平级奖：按北京日聚合「直推同级下级」当日团队收益（团队奖+级差）的 10%，幂等可补差
const parity = teamService.settleParityRewards(settleAt);
if (parity?.settled) console.log(`平级奖：${parity.count} 条，合计 ${parity.totalA} AIX`);

const minerReleased = sumSince('a_token_miner_releases', 'released_at');
const stakeReleased = sumSince('a_token_stake_rewards', 'settled_at');

console.log(`矿机：处理 ${minerTouched} 台，释放 ${formatUnits(minerReleased, 18)} AIX`);
console.log(`质押：处理 ${stakeTouched} 单，释放 ${formatUnits(stakeReleased, 18)} AIX`);
console.log(`合计释放 ${formatUnits(minerReleased + stakeReleased, 18)} AIX`);
process.exit(0);
